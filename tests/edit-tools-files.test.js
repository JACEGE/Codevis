const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, it } = require("node:test");
require("../lib/tsx-userinfo-preload.cjs");
const { register } = require("tsx/cjs/api");
const { openTestDb } = require("./helpers/ladybug-session.cjs");

const unregister = register();
after(() => unregister());

// File-level behaviour of the edit tools against real files and a real graph.
let db, ctx, project, previousProject, editTools;
before(async () => {
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codevis-edit-files-")));
    previousProject = process.env.CODEVIS_PROJECT_DIR;
    process.env.CODEVIS_PROJECT_DIR = project;
    editTools = require("../tools/handlers/edit-tools.ts").editTools;
    db = await openTestDb();
    const driver = { session: () => db.session };
    ctx = { targetDriver: driver, metaDriver: driver, defaultAgentId: "agent-1", lockingEnabled: false };
});
after(async () => {
    if (previousProject === undefined) delete process.env.CODEVIS_PROJECT_DIR;
    else process.env.CODEVIS_PROJECT_DIR = previousProject;
    await db?.cleanup();
    fs.rmSync(project, { recursive: true, force: true });
});

const call = async (name, args) => JSON.parse((await editTools.handlers[name]({ agentId: "agent-1", ...args }, ctx)).content[0].text);
const read = (file) => fs.readFileSync(path.join(project, file), "utf8");
const seed = async (file, name, uid, startLine, endLine) => {
    await db.session.run(`MERGE (f:File {path: $file})`, { file });
    await db.session.run(`MERGE (n:Function {uid: $uid}) SET n.name = $name, n.file = $file, n.startLine = $startLine, n.endLine = $endLine`,
        { uid, name, file, startLine, endLine });
};

it("insert_code at end_of_file keeps a single final newline", async () => {
    fs.writeFileSync(path.join(project, "eof.js"), "const a = 1;\n");
    const result = await call("insert_code", { file: "eof.js", code: "const b = 2;", position: "end_of_file" });
    assert.equal(result.status, "OK", JSON.stringify(result));
    assert.equal(read("eof.js"), "const a = 1;\nconst b = 2;\n");
});

it("insert_code keeps CRLF line endings and a function's doc comment", async () => {
    fs.writeFileSync(path.join(project, "crlf.js"), "/** Adds. */\r\nfunction add(a, b) {\r\n  return a + b;\r\n}\r\n");
    const result = await call("insert_code", { file: "crlf.js", code: "const x = 1;\nconst y = 2;", position: "before_function", anchorFunction: "add" });
    assert.equal(result.status, "OK", JSON.stringify(result));
    assert.equal(read("crlf.js"), "const x = 1;\r\nconst y = 2;\r\n/** Adds. */\r\nfunction add(a, b) {\r\n  return a + b;\r\n}\r\n");
});

it("edit_code_patch matches a multi-line LF oldString in a CRLF file", async () => {
    fs.writeFileSync(path.join(project, "patch.js"), "function calc(a) {\r\n  const b = a + 1;\r\n  return b;\r\n}\r\n");
    await seed("patch.js", "calc", "fn-calc", 1, 4);
    const result = await call("edit_code_patch", { file: "patch.js", functionName: "calc",
        oldString: "  const b = a + 1;\n  return b;", newString: "  const b = a + 2;\n  return b * 2;" });
    assert.equal(result.status, "OK", JSON.stringify(result));
    assert.equal(read("patch.js"), "function calc(a) {\r\n  const b = a + 2;\r\n  return b * 2;\r\n}\r\n");
});

it("a file mixing LF and CRLF keeps every line's ending and correct line numbers", async () => {
    // One CRLF line in an otherwise LF file.
    fs.writeFileSync(path.join(project, "mixed.js"), "const a = 1;\nconst b = 2;\r\nfunction f() {\n  return 1;\n}\n");
    await seed("mixed.js", "f", "fn-mixed", 3, 5);
    const patched = await call("edit_code_patch", { file: "mixed.js", functionName: "f", oldString: "{\n  return 1;", newString: "{\n  return 2;" });
    assert.equal(patched.status, "OK", JSON.stringify(patched));
    assert.equal(read("mixed.js"), "const a = 1;\nconst b = 2;\r\nfunction f() {\n  return 2;\n}\n");
    const inserted = await call("insert_code", { file: "mixed.js", code: "const c = 3;", position: "before_function", anchorFunction: "f" });
    assert.equal(inserted.status, "OK", JSON.stringify(inserted));
    // Right above the function, with the ending of the line it follows; nothing else rewritten.
    assert.equal(read("mixed.js"), "const a = 1;\nconst b = 2;\r\nconst c = 3;\r\nfunction f() {\n  return 2;\n}\n");
});

it("insert_code before a Python function stays below the shebang and encoding line", async () => {
    fs.writeFileSync(path.join(project, "tool.py"), "#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\ndef main():\n    return 1\n");
    const result = await call("insert_code", { file: "tool.py", code: "LIMIT = 3", position: "before_function", anchorFunction: "main" });
    assert.equal(result.status, "OK", JSON.stringify(result));
    assert.equal(read("tool.py"), "#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nLIMIT = 3\ndef main():\n    return 1\n");
});

it("rollback_edit refuses to discard a later edit of the same file", async () => {
    fs.writeFileSync(path.join(project, "roll.js"), "function one() {\n  return 1;\n}\n\nfunction two() {\n  return 2;\n}\n");
    await seed("roll.js", "one", "fn-one", 1, 3);
    await seed("roll.js", "two", "fn-two", 5, 7);
    const first = await call("edit_code_patch", { file: "roll.js", functionName: "one", oldString: "return 1;", newString: "return 10;" });
    assert.equal(first.status, "OK", JSON.stringify(first));
    await new Promise(resolve => setTimeout(resolve, 5));
    const second = await call("edit_code_patch", { agentId: "agent-2", file: "roll.js", functionName: "two", oldString: "return 2;", newString: "return 20;" });
    assert.equal(second.status, "OK", JSON.stringify(second));

    const refused = await call("rollback_edit", { file: "roll.js", backupToken: first.backupToken });
    assert.equal(refused.status, "NEWER_EDITS");
    assert.match(read("roll.js"), /return 20;/);
    const forced = await call("rollback_edit", { file: "roll.js", backupToken: first.backupToken, force: true });
    assert.notEqual(forced.status, "NEWER_EDITS");
});
