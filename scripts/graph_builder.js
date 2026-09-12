const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { Parser, Language, Query } = require('web-tree-sitter');
const { parseSource } = require('./parser/parse-source.cjs');
// DB backend: embedded Ladybug through the compatibility client.
// (MERGE/SET werden vom Übersetzer auf das Single-Table-Modell abgebildet).
const ladybug = require('../server/ladybug-driver.cjs');
const paths = require('../server/codevis-paths.cjs');
const projectDir = paths.PROJECT_ROOT;
const { normalizeWorkspaceName, publicWorkspaceName } = require('../lib/workspace-names.cjs');
const config = paths.loadConfig();
const { relinkRealizations } = require('./spec/spec_db.cjs');
const { repairSeq } = require('./repair_seq.cjs');
const { syncKnowledgeMarkdown } = require('./knowledge_markdown.cjs');
const { relinkAnnotations } = require('./annotations/annotation_db.cjs');
const { collectSourceFiles, findFiles, IGNORED_DIRS, globToRegExp, compileExcludeMatchers } = require('../lib/source-files.cjs');

// Labels that survive a full rebuild. Everything else is derived from source
// and gets re-parsed; these are authored by humans or imported from diagrams
// and exist nowhere else, so deleting them loses data for good.
//
// Spec* bindings are stored as `value` (boundUid) referencing the stable
// code-node uids, so they re-resolve after the rebuild.
//
// Enumerated explicitly rather than matched as `label STARTS WITH 'Spec'`
// because this query must run on both backends: Ladybug rewrites `NOT n:Foo`
// to `n.label <> 'Foo'` against its single-table schema, while Neo4j
// (CODEVIS_DB=neo4j) has real labels and no `label` property to match on.
//
// A label missing from this list is a SILENT data wipe — SpecField was absent
// for its whole life, so every full rebuild deleted all class attributes.
// tests/builder-preserve.test.js asserts this list covers every Spec* label
// that scripts/spec/spec_db.cjs actually creates.
const PRESERVED_LABELS = [
  'RuntimeDOM', 'Counter', 'Task', 'Epic', 'Knowledge', 'Annotation', 'BraindumpSession',
  // Idea is user-authored content like Task/Knowledge — a rebuild of the CODE
  // graph must never take it along. Absent from this list, the first
  // `build full` after the Idea Dump landed would silently empty the column.
  'Idea', 'TaskScope',
  'SpecSequence', 'SpecParticipant', 'SpecMessage',
  'SpecClassDiagram', 'SpecClass', 'SpecMethod', 'SpecField', 'SpecRelation',
  'SpecUseCaseDiagram', 'SpecActor', 'SpecUseCase', 'SpecAssoc',
  'SpecActivityDiagram', 'SpecProcess', 'SpecAction',
];

// Same resolution as the daemon and the driver — the build marker has to land in
// the data dir the rest of the toolchain looks at, not next to this script.
// Which optional verticals (ROS, ...) run for this build — see scripts/extractors.cjs.
const { resolveExtractors, reportExtractors } = require('./extractors.cjs');
// ROS semantics (which factory call means what) live in one pure module so the
// builder and the diagram generator cannot drift apart. Required unconditionally
// because it is side-effect-free: the extractor gate is about queries and graph
// writes, which is where the cost of a vertical actually is.
const rosModel = require('./ros/ros_model.js');

// Paths stored in the graph are platform-independent: ALWAYS forward slashes.
// Without this, a graph built on Windows stores `tools\foo.js` while every
// query (MCP handlers, tests, frontend links) asks for `tools/foo.js`.
// path.resolve()/fs accept forward slashes on Windows, so reads stay simple.
function toGraphPath(p) {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
}

function relGraphPath(baseDir, file) {
  return toGraphPath(path.relative(baseDir, file));
}

// ============================================================
// MTIME HELPER — incremental mode
// ============================================================

async function getMtimeChangedFiles(session, allFiles, baseDir) {
  const result = await session.run(
    'MATCH (f:File) RETURN f.path AS path, f.lastParsed AS lastParsed, f.parseStatus AS parseStatus, f.contentHash AS contentHash'
  );
  const dbTimestamps = new Map();
  for (const record of result.records) {
    dbTimestamps.set(record.get('path'), {
      lastParsed: record.get('lastParsed'), parseStatus: record.get('parseStatus'), contentHash: record.get('contentHash'),
    });
  }

  return allFiles.filter(file => {
    const relativePath = relGraphPath(baseDir, file);
    const mtime = fs.statSync(file).mtimeMs;
    const state = dbTimestamps.get(relativePath);
    const lastParsed = state?.lastParsed;
    return !state || state.parseStatus === 'parse_error'
      || lastParsed === null || lastParsed === undefined || mtime > lastParsed
      || !state.contentHash
      || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== state.contentHash;
  });
}

// ============================================================
// TREE-SITTER QUERIES — Per-Language
// ============================================================

const JS_FUNC_QUERY = `
  (function_declaration name: (identifier) @func_name) @func_node
  (generator_function_declaration name: (identifier) @func_name) @func_node
  (variable_declarator
    name: (identifier) @func_name
    value: [(arrow_function) (function_expression) (generator_function)] @func_node)
  ; Eine private Methode traegt einen (private_property_identifier), keinen
  ; (property_identifier). Ohne die Alternative fehlte jede private Methode im
  ; Graphen — die Klasse zeigte nur ihre oeffentliche Haelfte, und
  ; jsTsFunctionSemantics' Regel "Name beginnt mit # => visibility private"
  ; konnte nie greifen, weil kein solcher Name je ankam.
  (method_definition
    name: [(property_identifier) (private_property_identifier)] @func_name) @func_node
  ; Ein Symbol-Methodenname steht in einem computed_property_name. Erfasst wird
  ; dessen Inhalt, nicht der Knoten selbst: sonst hiesse die Methode
  ; "[Symbol.iterator]" mit Klammern im Diagrammkasten. Bewusst nur Identifier
  ; und Member-Ausdruecke; ein berechneter Ausdruck hat zur Analysezeit keinen
  ; Namen und bleibt draussen.
  (method_definition
    name: (computed_property_name [(identifier) (member_expression)] @func_name)) @func_node
  (field_definition
    property: [(property_identifier) (private_property_identifier)] @func_name
    value: [(arrow_function) (function_expression)] @func_node)
  (pair
    key: (property_identifier) @func_name
    value: [(arrow_function) (function_expression)] @func_node)
  (assignment_expression
    left: [(identifier) @func_name
           (member_expression property: (property_identifier) @func_name)]
    right: [(arrow_function) (function_expression)] @func_node)
`;

const TS_FUNC_QUERY = `
  (function_declaration name: (identifier) @func_name) @func_node
  (generator_function_declaration name: (identifier) @func_name) @func_node
  (variable_declarator
    name: (identifier) @func_name
    value: [(arrow_function) (function_expression) (generator_function)] @func_node)
  ; Siehe JS_FUNC_QUERY: private und berechnete Methodennamen sitzen in
  ; anderen Knotenarten als (property_identifier) und fehlten sonst komplett.
  ;
  ; Der Rückgabetyp wird als INHALT der type_annotation erfasst, nicht als die
  ; Annotation selbst. extractFunctions setzt die Signatur aus Name, Parametern
  ; und ": " + Rückgabetyp zusammen; ohne Capture fiel es auf
  ; childForFieldName('return_type') zurück, und dessen Text beginnt bereits
  ; mit einem Doppelpunkt. Im PlantUML-Kasten stand deshalb
  ; "find(id: string): : Item" mit zwei Doppelpunkten.
  (method_definition
    name: [(property_identifier) (private_property_identifier)] @func_name
    return_type: (type_annotation (_) @return_type)?) @func_node
  (method_definition
    name: (computed_property_name [(identifier) (member_expression)] @func_name)
    return_type: (type_annotation (_) @return_type)?) @func_node
  (public_field_definition
    name: [(property_identifier) (private_property_identifier)] @func_name
    value: [(arrow_function) (function_expression)] @func_node)
  (pair
    key: (property_identifier) @func_name
    value: [(arrow_function) (function_expression)] @func_node)
  (assignment_expression
    left: [(identifier) @func_name
           (member_expression property: (property_identifier) @func_name)]
    right: [(arrow_function) (function_expression)] @func_node)
  (function_signature name: (identifier) @func_name) @func_node
  (method_signature
    name: (property_identifier) @func_name
    return_type: (type_annotation (_) @return_type)?) @func_node
  (abstract_method_signature
    name: (property_identifier) @func_name
    return_type: (type_annotation (_) @return_type)?) @func_node
`;

// Die Queries verlangen absichtlich keine @params-Captures mehr. Ein Arrow mit
// genau einem unbeklammerten Parameter besitzt laut Grammatik `parameter:`,
// alle anderen Funktionen `parameters:`. extractFunctions liest beide Felder
// direkt vom @func_node; eine Query-Alternative pro Parameterform würde
// exportierte und verschachtelte Definitionen leicht doppelt erfassen.

// `"async"` has to come FIRST in the pattern: an anonymous token is matched
// positionally against the source, so `... return_type: (type)? "async"?` never
// fires and every coroutine silently lost its `Async` label. Putting it first
// makes `match.captures[0]` the token rather than @func_name for async defs —
// extractFunctions only uses captures[0] to walk up to the enclosing
// definition node, and the token's parent IS that node, so it still resolves.
//
// The second pattern covers a named lambda (`handler = lambda x: ...`). The
// walker in extractFunctions finds no known definition type above the
// identifier and falls back to the capture's parent — the `assignment` — which
// is exactly the span to report.
const PY_FUNC_QUERY = `
  (function_definition
    "async"? @is_async
    name: (identifier) @func_name
    parameters: (parameters) @params
    return_type: (type)? @return_type
  )
  (assignment
    left: (identifier) @func_name
    right: (lambda parameters: (lambda_parameters)? @params)
  )
`;

// ============================================================
// CLASS INHERITANCE
// ------------------------------------------------------------
// One query per language, because the syntax has nothing in common beyond the
// concept. Until these existed only Python was covered, so INHERITS was empty
// for every other codebase — `class JsonStore extends GraphStore` produced no
// edge at all, and anything reading INHERITS (spec reconciliation, the class
// diagram) silently reported a flat hierarchy instead of an unsupported one.
//
// The node types are taken from the real grammars, not from the docs: the
// shapes differ more than expected (TS wraps the base in an `extends_clause`
// while JS puts it directly under `class_heritage`; Java and Ruby use named
// fields; C++ has an access specifier in between).
// ============================================================

// Python: class Foo(Bar, ns.Baz):
// `(attribute)` is matched as well, so dotted bases (`class Foo(rclpy.node.Node)`)
// are captured — with only `(identifier)` they were silently invisible.
//
// A parameterised base (`class Foo(Generic[T])`, `class Store(Mapping[str, int])`)
// parses as a `subscript`, NOT as `generic_type` — that node only appears in
// type annotations. Without the two subscript patterns those bases produced no
// INHERITS edge at all. `value:` is captured rather than the whole subscript so
// the base name is `Mapping`, not `Mapping[str, int]`, which is what the Class
// lookup in extractClassInheritance matches on.
//
// `metaclass=Meta` is deliberately NOT captured: it parses as a
// `keyword_argument` and is not a base class.
//
// `class A(object)` is the Python 2 spelling of `class A`, and `object` is the
// implicit root of every Python 3 class anyway. Captured, it produced an
// `ExternalBase {name: 'object'}` node that EVERY legacy class in a project
// points at — one hub in the middle of the diagram that states a fact true of
// all of them and therefore distinguishes none. The predicate drops the bare
// name only; a project class that genuinely happens to be called `object` in a
// module (`class A(schema.object)`) arrives as an attribute and is unaffected.
const PY_CLASS_INHERITANCE_QUERY = `
  (class_definition
    name: (identifier) @class_name
    superclasses: (argument_list [(identifier) (attribute)] @base_class)
    (#not-eq? @base_class "object")
  )
  (class_definition
    name: (identifier) @class_name
    superclasses: (argument_list (subscript value: (identifier) @base_class))
  )
  (class_definition
    name: (identifier) @class_name
    superclasses: (argument_list (subscript value: (attribute) @base_class))
  )
`;

// JavaScript: class A extends B / class A extends ns.B
//
// Ein Klassen-AUSDRUCK (`const A = class extends B {}`) ist keine
// class_declaration, sondern ein `class`-Knoten. Ohne die beiden Muster dafür
// blieb die verbreitete Fabrik-Schreibweise ohne jede Vererbungskante. Der
// Name kommt entweder von der Klasse selbst (`class Inner extends …`) oder,
// wenn sie anonym ist, von der Bindung — `!name` hält beide auseinander, sonst
// entstuenden für dieselbe Klasse zwei Kanten unter zwei Namen.
//
// `class A extends mixin(B, C)` ist keine Vererbung von `mixin`, sondern von
// B und C: die Fabrik gibt eine Klasse zurück, die beide einmischt. Deshalb
// werden die ARGUMENTE als Basisklassen erfasst und nicht der Funktionsname.
// Ein Aufruf ohne Klassenargumente (`extends makeBase({ … })`) erzeugt so
// weiterhin keine Kante, statt eine erfundene.
const JS_CLASS_INHERITANCE_QUERY = `
  (export_statement value: (parenthesized_expression (class !name
    (class_heritage [(identifier) (member_expression)] @base_class)) @anonymous_class))
  (export_statement value: (class !name
    (class_heritage (call_expression arguments: (arguments [(identifier) (member_expression)] @base_class)))) @anonymous_class)
  (export_statement value: (parenthesized_expression (class !name
    (class_heritage (call_expression arguments: (arguments [(identifier) (member_expression)] @base_class)))) @anonymous_class))
  (export_statement value: (class !name
    (class_heritage [(identifier) (member_expression)] @base_class)) @anonymous_class)
  (class_declaration
    name: (identifier) @class_name
    (class_heritage [(identifier) (member_expression)] @base_class))
  (class_declaration
    name: (identifier) @class_name
    (class_heritage (parenthesized_expression [(identifier) (member_expression)] @base_class)))
  (class_declaration
    name: (identifier) @class_name
    (class_heritage (call_expression arguments: (arguments [(identifier) (member_expression)] @base_class))))
  (class
    name: (identifier) @class_name
    (class_heritage [(identifier) (member_expression)] @base_class))
  (variable_declarator
    name: (identifier) @class_name
    value: (class !name (class_heritage [(identifier) (member_expression)] @base_class)))
`;

// TypeScript: the base sits inside an `extends_clause`, and `implements` is a
// second, separate clause. Both are drawn as inheritance — an implemented
// interface is part of the type hierarchy the diagram is meant to show.
//
// `abstract class` ist eine EIGENE Knotenart (abstract_class_declaration), kein
// class_declaration mit Modifier. Solange nur class_declaration abgefragt wurde,
// verlor jede abstrakte Basisklasse ihre extends- UND ihre implements-Kante —
// und damit genau die Klasse, an der in einer Hierarchie alles hängt.
//
// `implements ns.I` steht als (nested_type_identifier) da; ohne die Alternative
// war eine qualifiziert geschriebene Schnittstelle unsichtbar, während die
// unqualifizierte daneben eine Kante bekam.
//
// Ein `interface X extends Y` hängt nicht an einem class_heritage, sondern an
// einer extends_type_clause. Schnittstellenhierarchien fehlten deshalb
// vollständig, obwohl `implements` schon als Vererbung gezeichnet wurde.
//
// Mixin-Fabriken: siehe JS_CLASS_INHERITANCE_QUERY — die Argumente sind die
// Basisklassen, nicht die Fabrik.
const TS_CLASS_INHERITANCE_QUERY = `
  (export_statement value: (parenthesized_expression (class !name
    (class_heritage (extends_clause value: [(identifier) (member_expression)] @base_class))) @anonymous_class))
  (export_statement value: (parenthesized_expression (class !name
    (class_heritage (implements_clause [(type_identifier) (generic_type) (nested_type_identifier)] @base_class))) @anonymous_class))
  (export_statement value: (class !name
    (class_heritage (extends_clause (call_expression arguments: (arguments [(identifier) (member_expression)] @base_class))))) @anonymous_class)
  (export_statement value: (parenthesized_expression (class !name
    (class_heritage (extends_clause (call_expression arguments: (arguments [(identifier) (member_expression)] @base_class))))) @anonymous_class))
  (export_statement value: (class !name
    (class_heritage (extends_clause value: [(identifier) (member_expression)] @base_class))) @anonymous_class)
  (export_statement value: (class !name
    (class_heritage (implements_clause [(type_identifier) (generic_type) (nested_type_identifier)] @base_class))) @anonymous_class)
  (class_declaration
    name: (type_identifier) @class_name
    (class_heritage
      (extends_clause value: [(identifier) (member_expression)] @base_class)))
  (class_declaration
    name: (type_identifier) @class_name
    (class_heritage
      (implements_clause [(type_identifier) (generic_type) (nested_type_identifier)] @base_class)))
  (class_declaration
    name: (type_identifier) @class_name
    (class_heritage
      (extends_clause (call_expression arguments: (arguments [(identifier) (member_expression)] @base_class)))))
  (abstract_class_declaration
    name: (type_identifier) @class_name
    (class_heritage
      (extends_clause value: [(identifier) (member_expression)] @base_class)))
  (abstract_class_declaration
    name: (type_identifier) @class_name
    (class_heritage
      (implements_clause [(type_identifier) (generic_type) (nested_type_identifier)] @base_class)))
  (abstract_class_declaration
    name: (type_identifier) @class_name
    (class_heritage
      (extends_clause (call_expression arguments: (arguments [(identifier) (member_expression)] @base_class)))))
  (interface_declaration
    name: (type_identifier) @class_name
    (extends_type_clause [(type_identifier) (generic_type) (nested_type_identifier)] @base_class))
  (class
    name: (type_identifier) @class_name
    (class_heritage
      (extends_clause value: [(identifier) (member_expression)] @base_class)))
  (variable_declarator
    name: (identifier) @class_name
    value: (class !name
      (class_heritage
        (extends_clause value: [(identifier) (member_expression)] @base_class))))
`;

// C++: class A : public B, private ns::C / struct D : E
//
// `template_type` gehört zwingend in die Alternative. Eine Basis MIT
// Template-Argumenten (`class Box : public Base<T>`, `class C : public
// Base<int>`) ist in der Grammatik weder type_identifier noch
// qualified_identifier, sondern template_type — und erzeugte deshalb GAR KEINE
// Vererbungskante. Nicht etwa eine grob vereinfachte: die Kante fehlte
// vollständig, obwohl extractClassInheritance die Template-Argumente danach
// ohnehin abschneidet (`replace(/<.*$/s, '')`) und der Basisname damit
// eindeutig ist. Betroffen war jede CRTP- oder Policy-Basis und jedes
// `std::enable_shared_from_this<T>`.
const CPP_CLASS_INHERITANCE_QUERY = `
  (class_specifier
    name: (type_identifier) @class_name
    (base_class_clause [(type_identifier) (qualified_identifier) (template_type)] @base_class))
  (struct_specifier
    name: (type_identifier) @class_name
    (base_class_clause [(type_identifier) (qualified_identifier) (template_type)] @base_class))
`;

// Java: superclass and interfaces are distinct named fields.
//
// Die drei unteren Muster fehlten. `interface B extends A`, `enum E implements
// I` und `record P implements I` sind eigene Knotenarten (interface_declaration,
// enum_declaration, record_declaration) — die class_declaration-Muster sehen sie
// nicht. Ergebnis: die gesamte Interface-Hierarchie eines Java-Projekts, also
// genau der Teil, den ein Klassendiagramm zeigen soll, hatte null Kanten.
// `extends_interfaces` trägt anders als `super_interfaces` keinen Feldnamen.
const JAVA_CLASS_INHERITANCE_QUERY = `
  (class_declaration
    name: (identifier) @class_name
    superclass: (superclass [(type_identifier) @base_class
                             (scoped_type_identifier) @base_class
                             (generic_type (type_identifier) @base_class)
                             (generic_type (scoped_type_identifier) @base_class)]))
  (class_declaration
    name: (identifier) @class_name
    interfaces: (super_interfaces
      (type_list [(type_identifier) @base_class
                  (scoped_type_identifier) @base_class
                  (generic_type (type_identifier) @base_class)
                  (generic_type (scoped_type_identifier) @base_class)])))
  (interface_declaration
    name: (identifier) @class_name
    (extends_interfaces
      (type_list [(type_identifier) @base_class
                  (scoped_type_identifier) @base_class
                  (generic_type (type_identifier) @base_class)
                  (generic_type (scoped_type_identifier) @base_class)])))
  (enum_declaration
    name: (identifier) @class_name
    interfaces: (super_interfaces
      (type_list [(type_identifier) @base_class
                  (scoped_type_identifier) @base_class
                  (generic_type (type_identifier) @base_class)
                  (generic_type (scoped_type_identifier) @base_class)])))
  (record_declaration
    name: (identifier) @class_name
    interfaces: (super_interfaces
      (type_list [(type_identifier) @base_class
                  (scoped_type_identifier) @base_class
                  (generic_type (type_identifier) @base_class)
                  (generic_type (scoped_type_identifier) @base_class)])))
`;

// Ruby: class A < B
const RUBY_CLASS_INHERITANCE_QUERY = `
  (class
    name: (constant) @class_name
    superclass: (superclass (constant) @base_class))
`;

// ============================================================
// INSTANTIATION — `new Foo()` and friends
// ------------------------------------------------------------
// The call queries match `call_expression` only, so `new Session(...)` produced
// no edge at all: the single most common association in a UML class diagram
// ("this class creates that one") was invisible, and generated diagrams showed
// unconnected boxes for code that is anything but unconnected.
//
// Only edges to classes that EXIST in the graph are written — `new Map()` must
// not conjure a Map class. See extractInstantiations.
// ============================================================

const JS_NEW_QUERY = `
  (new_expression constructor: [(identifier) (member_expression)] @class_name)
`;

// C++ has two forms; only heap allocation is matched. A stack declaration
// (`Widget w(1);`) is syntactically identical to a function declaration —
// the classic most-vexing-parse — and guessing there would invent edges.
const CPP_NEW_QUERY = `
  (new_expression type: [(type_identifier) (qualified_identifier)] @class_name)
  (new_expression type: (template_type name: (type_identifier) @class_name))
  (call_expression function: (identifier) @class_name)
`;

const JAVA_NEW_QUERY = `
  (object_creation_expression type: [(type_identifier) (generic_type)] @class_name)
`;

// Python has no `new`: `Widget(1)` is an ordinary call and only the name tells
// you it is a constructor. Every call is captured and filtered afterwards
// against the classes actually in the graph, which is the only sound way to
// tell `Widget(1)` from `helper(1)`.
const PY_NEW_QUERY = `
  (call function: [(identifier) (attribute)] @class_name)
`;

// Python instance attributes whose class can be established in __init__:
//   self.state = State()
//   self.state: State = factory()
//   self.state: State
// Only the direct `self.<attribute>` shape is intentional. Inferring through
// containers, properties or `self.a.b` would require data-flow analysis rather
// than a trustworthy syntax-level fact.
const PY_ATTRIBUTE_TYPE_QUERY = `
  (assignment
    left: (attribute
      object: (identifier) @attr_owner
      attribute: (identifier) @attr_name)
    right: (call function: [(identifier) (attribute)] @attr_class))
  (assignment
    left: (attribute
      object: (identifier) @attr_owner
      attribute: (identifier) @attr_name)
    type: (type) @attr_type)
`;

const JS_IMPORT_QUERY = `
  (import_statement source: (string) @import_source)
`;

const JS_REQUIRE_QUERY = `
  (call_expression
    function: (identifier) @req_func
    arguments: (arguments (string) @import_source)
  )
`;

// Only two of the four Python import forms were matched. The other two produced
// no IMPORTS edge whatsoever, and nothing said so:
//
//   import numpy as np          -> the child is `aliased_import`, not `dotted_name`
//   from .mod import Thing      -> `module_name` is `relative_import`, not `dotted_name`
//
// The relative form is the normal way a packaged Python project imports its own
// modules, so for such a project the file-level dependency graph was close to
// empty. See resolveImportPath for how the leading dots are resolved — they are
// a package-level count, not a path prefix.
const PY_IMPORT_QUERY = `
  (import_statement name: (dotted_name) @import_source)
  (import_statement name: (aliased_import name: (dotted_name) @import_source))
  (import_from_statement module_name: (dotted_name) @import_source)
  (import_from_statement module_name: (relative_import) @import_source)
`;

// Python named imports: `from scoring import haversine` / `from models import A, B`
// / `from x import y as z`. Mirrors the capture names extractNamedImports expects
// (import_name / import_alias / import_source) so ImportedSymbol nodes get created
// for Python too — without these, cross-file CALLS stay unresolved (the call
// resolver gates on importedSymbols / imported-class methods).
// `module_name` accepts `relative_import` too — see PY_IMPORT_QUERY. Capturing
// the whole alternation is intended here: @import_source is handed to
// resolveImportPath as text, which wants `.mod` / `..pkg.deep` verbatim.
const PY_NAMED_IMPORT_QUERY = `
  (import_from_statement
    module_name: [(dotted_name) (relative_import)] @import_source
    name: (dotted_name) @import_name)
  (import_from_statement
    module_name: [(dotted_name) (relative_import)] @import_source
    name: (aliased_import name: (dotted_name) @import_name alias: (identifier) @import_alias))
`;

const JSX_COMPONENT_QUERY = `
  (jsx_opening_element
    name: [(identifier) (member_expression)] @component_name)
  (jsx_self_closing_element
    name: [(identifier) (member_expression)] @component_name)
`;

// Fragmente (`<>...</>`) sind in den installierten JS-/TSX-Grammatiken keine
// eigenen jsx_fragment-Knoten, sondern namenlose jsx_element-Knoten. Deshalb
// darf hier kein jsx_fragment stehen: die Query würde schon beim Kompilieren
// scheitern. Self-Closing-Elemente sind dagegen ein eigener Knotentyp.
const JSX_OUTPUT_QUERY = `
  (jsx_element) @jsx
  (jsx_self_closing_element) @jsx
`;

const JSX_PROP_QUERY = `
  (jsx_attribute (property_identifier) @prop_name)
`;

// JSX spread: <Component {...props} />
const JSX_SPREAD_QUERY = `
  (jsx_opening_element
    name: [(identifier) (member_expression)] @component_name
    (jsx_expression (spread_element (identifier) @spread_var))
  )
  (jsx_self_closing_element
    name: [(identifier) (member_expression)] @component_name
    (jsx_expression (spread_element (identifier) @spread_var))
  )
`;

// useState/useReducer liefern Wert plus Setter/Dispatch; useRef liefert nur
// einen Namen. Getrennte Captures verhindern, dass extractStates Ref-Namen als
// Setter des vorherigen State-Eintrags interpretiert.
const JS_REACT_STATE_QUERY = `
  (variable_declarator
    name: (array_pattern
      . (identifier) @state_name
      . (identifier)? @state_setter
      .)
    value: (call_expression
      function: (identifier) @hook_name
      (#match? @hook_name "^(useState|useReducer)$")))
  (variable_declarator
    name: (identifier) @state_name
    value: (call_expression
      function: (identifier) @hook_name
      (#eq? @hook_name "useRef")))
`;

// useContext: const ctx = useContext(MyContext)
const JS_USE_CONTEXT_QUERY = `
  (call_expression
    function: (identifier) @hook_name (#eq? @hook_name "useContext")
    arguments: (arguments (identifier) @context_name)
  )
`;

// Das Deps-Array ist optional: useEffect(() => subscribe()) ist gültiges und
// verbreitetes React. Ohne `?` verschwindet der Effect vollständig im Graphen.
const JS_HOOK_EFFECT_QUERY = `
  (call_expression
    function: (identifier) @hook_name
    arguments: (arguments
      (_) @callback
      (array)? @deps_array
    )
  )
`;

const JS_HTTP_QUERY = `
  (call_expression
    function: (identifier) @http_func
    arguments: (arguments (string) @http_url)
  )
  (call_expression
    function: (member_expression
      object: (identifier) @http_obj
      property: (property_identifier) @http_method)
    arguments: (arguments (string) @http_url)
  )
`;

const PY_HTTP_QUERY = `
  (decorated_definition
    (decorator
      (call
        function: (attribute
          object: (identifier) @http_obj
          attribute: (identifier) @http_method)
        arguments: (argument_list (string) @http_url)
      )
    )
    definition: (function_definition name: (identifier) @handler_name)
  )
`;

// Alias tracking: const x = myFunc / obj.method = myFunc
const JS_ALIAS_QUERY = `
  (lexical_declaration
    (variable_declarator
      name: (identifier) @alias_name
      value: (identifier) @original_name
    )
  )
  (variable_declaration
    (variable_declarator
      name: (identifier) @alias_name
      value: (identifier) @original_name
    )
  )
  (expression_statement
    (assignment_expression
      left: (member_expression
        property: (property_identifier) @alias_name)
      right: (identifier) @original_name
    )
  )
  (expression_statement
    (assignment_expression
      left: (identifier) @alias_name
      right: (identifier) @original_name
    )
  )
`;

// Callback tracking: .map(myFunc), addEventListener('click', handler)
const JS_CALLBACK_QUERY = `
  (call_expression
    function: (identifier) @caller_func
    arguments: (arguments (identifier) @callback_ref)
  )
  (call_expression
    function: (member_expression
      property: (property_identifier) @caller_method)
    arguments: (arguments (identifier) @callback_ref)
  )
`;

// Conditional calls: if (cond) { func() } / cond ? a() : b()
const JS_CONDITIONAL_CALL_QUERY = `
  (if_statement
    condition: (_) @condition
    consequence: (_) @then_branch
    alternative: (_)? @else_branch
  )
  (ternary_expression
    condition: (_) @tern_condition
    consequence: (_) @tern_then
    alternative: (_) @tern_else
  )
`;

// Async chains: .then(handler), .catch(handler), await func()
const JS_ASYNC_CHAIN_QUERY = `
  (call_expression
    function: (member_expression
      property: (property_identifier) @chain_method)
    arguments: (arguments (identifier) @chain_handler)
  )
  (await_expression
    (call_expression
      function: (identifier) @await_target)
  )
  (await_expression
    (call_expression
      function: (member_expression
        property: (property_identifier) @await_target))
  )
`;

// Named imports: import { foo, bar as baz } from './module'
const JS_NAMED_IMPORT_QUERY = `
  (import_statement
    (import_clause
      (named_imports
        (import_specifier
          name: (identifier) @import_name
          alias: (identifier)? @import_alias
        )
      )
    )
    source: (string) @import_source
  )
`;

// Named exports: export { foo, bar } / export const foo = ...
const JS_NAMED_EXPORT_QUERY = `
  (export_statement
    (export_clause
      (export_specifier
        name: (identifier) @export_name
        alias: (identifier)? @export_alias
      )
    )
    source: (string)? @reexport_source
  )
`;

// Nur den äußeren Call strukturell festlegen. extractReactWrappers steigt
// anschließend durch dessen erstes Argument, damit auch beliebig tiefe Ketten
// wie memo(forwardRef(...)) funktionieren. Eine rekursive tree-sitter-Query
// kann solche Ketten nicht ausdrücken, ohne jede Tiefe einzeln zu duplizieren.
const JS_REACT_WRAPPER_QUERY = `
  (variable_declarator
    name: (identifier) @component_name
    value: (call_expression
      function: [(identifier) @wrapper_func
                 (member_expression
                   object: (identifier) @react_ns
                   property: (property_identifier) @wrapper_func)]
      arguments: (arguments) @wrapper_args))
`;

// ============================================================
// ROS 2 QUERIES  (optional extractor — see scripts/extractors.cjs)
// ------------------------------------------------------------
// These capture the *call site* generically (method name + argument list) and
// leave the semantics — which argument is the topic, which is the type, is it a
// service or an action — to scripts/ros/ros_model.js. Encoding the argument
// layout in the query itself would need one query per factory per language and
// still could not express "the first string argument" (needed for the C++
// action factories, whose overloads shift the name around).
//
// The extractor reads positional arguments off @ros_args, so a call with an
// unresolvable name (`create_publisher(String, self.topic, 10)`) is still seen
// and recorded as a dynamic interface instead of being silently dropped.
// ============================================================

// roslib (rosbridge) in browser code: `new ROSLIB.Topic({name, messageType})`.
// NOTE: the previous version of this query matched EVERY call with a string
// argument, which made every string literal in the codebase a candidate topic.
// It only stayed quiet because a `startsWith('/')` filter downstream threw
// almost everything away — including the real relative-named topics.
const JS_ROS_TOPIC_QUERY = `
  (new_expression
    constructor: (member_expression property: (property_identifier) @ros_ctor)
    arguments: (arguments (object) @ros_obj))
  (new_expression
    constructor: (identifier) @ros_ctor
    arguments: (arguments (object) @ros_obj))
`;

// Python rclpy: `self.create_publisher(Twist, 'cmd_vel', 10)` and the action
// constructors `ActionServer(self, Fibonacci, 'fibonacci', cb)`.
const PY_ROS_INTERFACE_QUERY = `
  (call
    function: (attribute attribute: (identifier) @ros_method)
    arguments: (argument_list) @ros_args)
  (call
    function: (identifier) @ros_method
    arguments: (argument_list) @ros_args)
`;

// C++ rclcpp: both the member form `this->create_publisher<T>("cmd_vel", 10)`
// (template_method) and the free form `create_service<T>("reset", cb)`
// (template_function). The interface type lives in the template argument.
const CPP_ROS_INTERFACE_QUERY = `
  (call_expression
    function: (field_expression
      field: (template_method
        name: (field_identifier) @ros_method
        arguments: (template_argument_list) @ros_types))
    arguments: (argument_list) @ros_args)
  (call_expression
    function: (template_function
      name: (identifier) @ros_method
      arguments: (template_argument_list) @ros_types)
    arguments: (argument_list) @ros_args)
  (call_expression
    function: (qualified_identifier
      name: (template_function
        name: (identifier) @ros_method
        arguments: (template_argument_list) @ros_types))
    arguments: (argument_list) @ros_args)
`;

// The runtime node name: `super().__init__('minimal_publisher')` in Python,
// `: Node("minimal_publisher")` in a C++ constructor initialiser list.
const PY_ROS_NODE_NAME_QUERY = `
  (call
    function: (attribute
      object: (call function: (identifier) @super_fn)
      attribute: (identifier) @init_name)
    arguments: (argument_list (string (string_content) @node_name)))
`;

const CPP_ROS_NODE_NAME_QUERY = `
  (function_definition
    declarator: (function_declarator
      declarator: (identifier))
    (field_initializer_list
      (field_initializer
        (field_identifier) @init_name
        (argument_list (string_literal (string_content) @node_name)))))
  (function_definition
    declarator: (function_declarator
      declarator: (qualified_identifier
        scope: (namespace_identifier) @constructor_scope
        name: (identifier)))
    (field_initializer_list
      (field_initializer
        (field_identifier) @init_name
        (argument_list (string_literal (string_content) @node_name)))))
`;

// C++ class inheritance is NOT redefined here on purpose: the core builder
// already extracts it for every language (CPP_CLASS_INHERITANCE_QUERY above),
// so a ROS node class is recognised whether or not this extractor runs.

// ============================================================
// FULL-AST QUERIES — Control Flow, Variables, Statements
// ============================================================

const JS_CONTROL_FLOW_QUERY = `
  (if_statement) @if_stmt
  (for_statement) @for_stmt
  (for_in_statement) @for_in_stmt
  (while_statement) @while_stmt
  (do_statement) @do_while_stmt
  (switch_statement) @switch_stmt
  (try_statement) @try_stmt
`;

const JS_STATEMENT_QUERY = `
  (return_statement) @return_stmt
  (throw_statement) @throw_stmt
  (break_statement) @break_stmt
  (continue_statement) @continue_stmt
`;

// Klassenfelder sind das Attributfach des Klassendiagramms. Ohne die
// field_definition-Muster war jede JS-Klasse eine reine Methodenliste, obwohl
// die Felder direkt danebenstehen. `this.x = …` gehört dazu: was ein
// Konstruktor zuweist, ist genauso ein Feld wie eine Deklaration im Rumpf.
const JS_VARIABLE_QUERY = `
  (variable_declarator name: (identifier) @var_name)
  (formal_parameters (identifier) @param_name)
  (field_definition property: (property_identifier) @field_name)
  (field_definition property: (private_property_identifier) @field_name)
  (assignment_expression
    left: (member_expression object: (this) property: (property_identifier) @field_name))
`;

/**
 * TypeScript braucht eine eigene Query, und zwar nicht nur wegen der Felder.
 *
 * Die JS-Variante liess sich gegen die TypeScript-Grammatik NIE übersetzen:
 * dort stehen unter `formal_parameters` keine blossen `identifier`, sondern
 * `required_parameter` und `optional_parameter`. safeQuery faengt den Fehler ab
 * und gibt null zurück -- lautlos. Für .ts und .tsx entstand damit kein
 * einziger Variable-Knoten: keine Felder, keine lokalen Variablen, keine
 * Parameter. Im Graphen sah das aus wie Code ohne Daten, nicht wie ein
 * kaputter Extraktor.
 *
 * Ebenso heissen Klassenfelder hier `public_field_definition` (auch die mit
 * `private`/`protected`) statt `field_definition`, und ein Interface trägt
 * seine Felder als `property_signature`.
 */
const TS_VARIABLE_QUERY = `
  (variable_declarator name: (identifier) @var_name)
  (required_parameter pattern: (identifier) @param_name)
  (optional_parameter pattern: (identifier) @param_name)
  (public_field_definition name: (property_identifier) @field_name)
  (public_field_definition name: (private_property_identifier) @field_name)
  (property_signature name: (property_identifier) @field_name)
  (assignment_expression
    left: (member_expression object: (this) property: (property_identifier) @field_name))
`;

// `with` is how Python does resource scoping and `match` is how it branches
// since 3.10; neither produced a flow node. The clause-level nodes matter too:
// an `if/elif/elif/else` chain used to be a single node, so the graph showed one
// branch where the code has four. Comprehensions are loops — a
// `list_comprehension` iterates just as much as a `for_statement` does.
const PY_CONTROL_FLOW_QUERY = `
  (if_statement) @if_stmt
  (elif_clause) @elif_stmt
  (else_clause) @else_stmt
  (for_statement) @for_stmt
  (while_statement) @while_stmt
  (try_statement) @try_stmt
  (except_clause) @except_stmt
  (finally_clause) @finally_stmt
  (with_statement) @with_stmt
  (match_statement) @match_stmt
  (case_clause) @case_stmt
  (list_comprehension) @comprehension_stmt
  (set_comprehension) @comprehension_stmt
  (dictionary_comprehension) @comprehension_stmt
  (generator_expression) @comprehension_stmt
`;

// `yield` is the one that changes meaning rather than just adding detail: a
// function containing it is a generator, and without the node nothing in the
// graph distinguishes it from a function that returns a list.
const PY_STATEMENT_QUERY = `
  (return_statement) @return_stmt
  (raise_statement) @throw_stmt
  (break_statement) @break_stmt
  (continue_statement) @continue_stmt
  (pass_statement) @pass_stmt
  (assert_statement) @assert_stmt
  (delete_statement) @delete_stmt
  (global_statement) @global_stmt
  (nonlocal_statement) @nonlocal_stmt
  (yield) @yield_stmt
  (await) @await_stmt
`;

// The two-line version of this query saw a minority of the Python it was
// pointed at. Measured over a 19-file rclpy codebase: 412 of 569 parameters
// (72%) and 337 of 876 assignment targets (38%) were invisible, because
// `(parameters (identifier))` only matches a bare, untyped parameter and
// `(assignment left: (identifier))` only matches a bare local.
//
// In annotated Python — which is most Python now — a parameter is a
// `typed_parameter`, `typed_default_parameter`, `default_parameter`,
// `list_splat_pattern` (*args) or `dictionary_splat_pattern` (**kwargs). Each
// needs its own pattern with the capture placed on the inner identifier: an
// alternation captures the node it is attached to, so
// `[(identifier) (typed_parameter ...)] @param_name` would yield the text
// "limit: float" instead of "limit".
//
// Note the two nested splat patterns: an ANNOTATED `*args: int` is a
// `typed_parameter` wrapping a `list_splat_pattern`, not a top-level
// `list_splat_pattern`, so the plain splat pattern alone misses it.
//
// `self.x = …` is captured separately as @field_name. Those 300 assignments are
// the instance fields — the attributes a UML class diagram is made of — and
// they were the single largest hole. extractAllVariables gives them
// scope='field' and hangs them off the enclosing class.
//
// The RECEIVER has to be checked, not just the shape. `attribute: (identifier)`
// alone matches every dotted assignment there is, so `cfg.timeout = 5`,
// `logging.root.level = 1` and `self.state.ready = False` inside a method all
// became fields of the enclosing class — the attribute compartment filled up
// with other objects' attributes, and a reader cannot tell those from the real
// ones. `object:` pins it to `self` (an instance field) or `cls` (a class
// attribute set in a classmethod); `self.state.ready` no longer matches because
// its object is an attribute, not an identifier — `ready` belongs to `state`.
//
// @field_owner exists only so the predicate has something to test. It is never
// a variable: extractAllVariables drops the names `self` and `cls` outright,
// the same way it drops `this` in JS.
const PY_VARIABLE_QUERY = `
  (assignment left: (identifier) @var_name)
  (assignment
    left: (attribute object: (identifier) @field_owner attribute: (identifier) @field_name)
    (#match? @field_owner "^(self|cls)$"))
  (assignment left: (subscript value: (identifier) @var_name))
  (assignment left: (pattern_list (identifier) @var_name))
  (assignment
    left: (pattern_list (attribute object: (identifier) @field_owner attribute: (identifier) @field_name))
    (#match? @field_owner "^(self|cls)$"))
  (assignment left: (tuple_pattern (identifier) @var_name))
  (assignment
    left: (tuple_pattern (attribute object: (identifier) @field_owner attribute: (identifier) @field_name))
    (#match? @field_owner "^(self|cls)$"))
  (augmented_assignment left: (identifier) @var_name)
  (augmented_assignment
    left: (attribute object: (identifier) @field_owner attribute: (identifier) @field_name)
    (#match? @field_owner "^(self|cls)$"))
  (for_statement left: (identifier) @var_name)
  (for_statement left: (pattern_list (identifier) @var_name))
  (for_statement left: (tuple_pattern (identifier) @var_name))
  (for_in_clause left: (identifier) @var_name)
  (for_in_clause left: (pattern_list (identifier) @var_name))
  (for_in_clause left: (tuple_pattern (identifier) @var_name))
  (with_item value: (as_pattern alias: (as_pattern_target (identifier) @var_name)))
  (except_clause value: (as_pattern alias: (as_pattern_target (identifier) @var_name)))
  (as_pattern (case_pattern) . (identifier) @var_name)
  (named_expression name: (identifier) @var_name)
  (global_statement (identifier) @var_name)
  (nonlocal_statement (identifier) @var_name)
  (parameters (identifier) @param_name)
  (parameters (typed_parameter (identifier) @param_name))
  (parameters (typed_parameter (list_splat_pattern (identifier) @param_name)))
  (parameters (typed_parameter (dictionary_splat_pattern (identifier) @param_name)))
  (parameters (default_parameter name: (identifier) @param_name))
  (parameters (default_parameter name: (tuple_pattern (identifier) @param_name)))
  (parameters (typed_default_parameter name: (identifier) @param_name))
  (parameters (list_splat_pattern (identifier) @param_name))
  (parameters (dictionary_splat_pattern (identifier) @param_name))
  (lambda_parameters (identifier) @param_name)
  (lambda_parameters (default_parameter name: (identifier) @param_name))
`;

const JS_AST_QUERY = `
  (binary_expression) @BinaryExpression
  (assignment_expression) @AssignmentExpression
  (augmented_assignment_expression) @AugmentedAssignment
  (member_expression) @MemberExpression
  (subscript_expression) @SubscriptExpression
  (ternary_expression) @TernaryExpression
  (unary_expression) @UnaryExpression
  (update_expression) @UpdateExpression
  (new_expression) @NewExpression
  (arrow_function) @ArrowFunction
  (function_expression) @FunctionExpression
  (template_string) @TemplateLiteral
  (array) @ArrayExpression
  (object) @ObjectExpression
  (string) @StringLiteral
  (number) @NumberLiteral
`;

const PY_AST_QUERY = `
  (binary_operator) @BinaryExpression
  (boolean_operator) @LogicalExpression
  (comparison_operator) @ComparisonExpression
  (augmented_assignment) @AugmentedAssignment
  (attribute) @MemberExpression
  (subscript) @SubscriptExpression
  (slice) @SliceExpression
  (conditional_expression) @TernaryExpression
  (unary_operator) @UnaryExpression
  (not_operator) @UnaryExpression
  (lambda) @ArrowFunction
  (call) @CallExpression
  (await) @AwaitExpression
  (named_expression) @AssignmentExpression
  (keyword_argument) @KeywordArgument
  (string) @StringLiteral
  (concatenated_string) @StringLiteral
  (interpolation) @TemplateInterpolation
  (integer) @NumberLiteral
  (float) @NumberLiteral
  (true) @BooleanLiteral
  (false) @BooleanLiteral
  (none) @NullLiteral
  (list) @ArrayExpression
  (dictionary) @ObjectExpression
  (set) @SetExpression
  (tuple) @TupleExpression
  (list_comprehension) @Comprehension
  (set_comprehension) @Comprehension
  (dictionary_comprehension) @Comprehension
  (generator_expression) @Comprehension
`;

// ============================================================
// PYTHON: the queries that simply did not exist
// ------------------------------------------------------------
// extractCallbacks, extractAliases, extractAsyncChains,
// extractConditionalCalls and extractNamedExports are language-neutral and had
// been running for JS/TS all along. Python passed them nothing, so
// PASSES_CALLBACK, ALIAS_OF, AWAITS, CALLS_CONDITIONALLY and EXPORTS_SYMBOL
// were empty for every Python file — not "not supported", just absent.
// ============================================================

// Passing a function by name. In rclpy this is how the entire event surface is
// wired — `self.create_timer(0.1, self.on_tick)`,
// `self.create_subscription(Msg, 'topic', self.on_msg, 10)` — so without it
// every timer and subscription callback looked like dead code that nobody calls.
//
// Each form is a separate pattern because the capture must land on the inner
// identifier: for `self.on_tick` we want "on_tick", and an alternation
// (`[(identifier) (attribute ...)] @callback_ref`) captures the outer node and
// yields "self.on_tick", which matches no function name and edges nothing.
//
// Over-capture is safe by construction: extractCallbacks resolves the name
// against the functions actually in the graph, so a plain data argument
// (`self.work(fh)`, `create_subscription(Msg, …)`) resolves to nothing.
const PY_CALLBACK_QUERY = `
  (call function: (identifier) @caller_func
    arguments: (argument_list (identifier) @callback_ref))
  (call function: (identifier) @caller_func
    arguments: (argument_list (attribute attribute: (identifier) @callback_ref)))
  (call function: (identifier) @caller_func
    arguments: (argument_list (keyword_argument value: (identifier) @callback_ref)))
  (call function: (identifier) @caller_func
    arguments: (argument_list (keyword_argument value: (attribute attribute: (identifier) @callback_ref))))
  (call function: (attribute attribute: (identifier) @caller_method)
    arguments: (argument_list (identifier) @callback_ref))
  (call function: (attribute attribute: (identifier) @caller_method)
    arguments: (argument_list (attribute attribute: (identifier) @callback_ref)))
  (call function: (attribute attribute: (identifier) @caller_method)
    arguments: (argument_list (keyword_argument value: (identifier) @callback_ref)))
  (call function: (attribute attribute: (identifier) @caller_method)
    arguments: (argument_list (keyword_argument value: (attribute attribute: (identifier) @callback_ref))))
`;

// Which local name refers to which module: `import event_log` binds
// `event_log`, `import pkg.sub` binds `pkg`, `import event_log as el` binds
// `el`. extractCalls needs this to turn the receiver of `event_log.log()` into
// a file. The alias form is why the module path cannot simply be read off the
// receiver text.
const PY_MODULE_ALIAS_QUERY = `
  (import_statement name: (dotted_name) @module_path)
  (import_statement
    name: (aliased_import name: (dotted_name) @module_path alias: (identifier) @module_alias))
`;

// `handler = process` / `self.handler = self.on_tick`. The attribute-target
// forms matter as much as the plain ones: stashing a bound method on `self` is
// the usual way Python code keeps a callback around. extractAliases only keeps
// the edge when the right-hand name is a known function, so ordinary value
// assignments fall away on their own.
const PY_ALIAS_QUERY = `
  (assignment left: (identifier) @alias_name right: (identifier) @original_name)
  (assignment left: (identifier) @alias_name right: (attribute attribute: (identifier) @original_name))
  (assignment left: (attribute attribute: (identifier) @alias_name) right: (identifier) @original_name)
  (assignment left: (attribute attribute: (identifier) @alias_name) right: (attribute attribute: (identifier) @original_name))
`;

// `await` is its own node type in this grammar (not `await_expression`).
const PY_ASYNC_CHAIN_QUERY = `
  (await (call function: (identifier) @await_target))
  (await (call function: (attribute attribute: (identifier) @await_target)))
`;

// The ternary's three children carry NO field names, so the pattern is
// positional and MUST be anchored with `.` — unanchored, the three wildcards
// match every ordered triple in the subtree and a single expression produced a
// fan of bogus condition/branch combinations. Source order is
// value-if-true, condition, value-if-false.
const PY_CONDITIONAL_CALL_QUERY = `
  (if_statement
    condition: (_) @condition
    consequence: (_) @then_branch
    alternative: (_)? @else_branch)
  (conditional_expression
    . (_) @tern_then
    . (_) @tern_condition
    . (_) @tern_else .)
`;

// Python's public surface is `__all__`, not an export keyword. The predicate is
// what keeps this from treating every list-of-strings assignment as an export.
const PY_NAMED_EXPORT_QUERY = `
  (expression_statement
    (assignment
      left: (identifier) @all_marker
      right: (list (string (string_content) @export_name))
      (#eq? @all_marker "__all__")))
`;

// Decorators are a real dependency — `@app.route(...)`, `@pytest.fixture`,
// `@abstractmethod` — and none of them were in the graph. Three forms: `@name`,
// `@a.b.c` and `@name(args)`.
//
// The call form needs its OWN pattern rather than a slot in an alternation.
// A capture attached to an alternation binds the alternation's node, so
// `[(identifier) (attribute) (call function: (_))] @decorator_ref` yielded the
// whole call — "dataclasses.dataclass(frozen=True)" — whose last dot-segment is
// "dataclass(frozen=True)" and matches no function, silently costing every
// call-form decorator its DECORATED_BY edge.
const PY_DECORATOR_QUERY = `
  (decorated_definition
    (decorator (identifier) @decorator_ref)
    definition: [(function_definition name: (identifier) @decorated_name)
                 (class_definition name: (identifier) @decorated_name)])
  (decorated_definition
    (decorator (attribute) @decorator_ref)
    definition: [(function_definition name: (identifier) @decorated_name)
                 (class_definition name: (identifier) @decorated_name)])
  (decorated_definition
    (decorator (call function: [(identifier) (attribute)] @decorator_ref))
    definition: [(function_definition name: (identifier) @decorated_name)
                 (class_definition name: (identifier) @decorated_name)])
`;

// Type annotations are the strongest association signal modern Python has, and
// they were used only as a display string on Function.return_type — never as an
// edge. `list[Obstacle]` and `Obstacle | None` nest the name arbitrarily deep
// (generic_type/type_parameter, binary_operator), so the whole `type` node is
// captured and the names are dug out in extractTypeReferences rather than
// enumerated as query shapes here.
const PY_TYPE_REF_QUERY = `
  (function_definition
    name: (identifier) @owner_name
    parameters: (parameters (typed_parameter type: (type) @type_ref)))
  (function_definition
    name: (identifier) @owner_name
    parameters: (parameters (typed_default_parameter type: (type) @type_ref)))
  (function_definition
    name: (identifier) @owner_name
    return_type: (type) @type_ref)
  (assignment left: (identifier) @owner_field type: (type) @type_ref)
  (assignment left: (attribute attribute: (identifier) @owner_field) type: (type) @type_ref)
`;

/**
 * Dieselbe Aussage in TypeScript, Java und C++.
 *
 * Bis hierher gab es typeRefQuery nur für Python, also entstanden USES_TYPE-
 * Kanten auch nur dort -- und mit ihnen die association-Pfeile des
 * Klassendiagramms. Ein Feld `private Customer owner;` sagt genauso deutlich
 * "hat ein", nur stand es in keinem Diagramm.
 *
 * Die Rolle entscheidet sich am Capture: @owner_field wird zur Kante der
 * besitzenden KLASSE (das ist die Assoziation), @owner_name zur Kante der
 * Funktion. Verschachtelte Typen (`Item[]`, `List<Item>`, `Map<string, Base>`)
 * löst collectTypeNames auf, das jeden Namen im Teilbaum einsammelt.
 */
const TS_TYPE_REF_QUERY = `
  (public_field_definition
    name: (property_identifier) @owner_field
    type: (type_annotation (_) @type_ref))
  (property_signature
    name: (property_identifier) @owner_field
    type: (type_annotation (_) @type_ref))
  (method_definition
    name: (property_identifier) @owner_name
    parameters: (formal_parameters (required_parameter type: (type_annotation (_) @type_ref))))
  (method_definition
    name: (property_identifier) @owner_name
    return_type: (type_annotation (_) @type_ref))
  (function_declaration
    name: (identifier) @owner_name
    parameters: (formal_parameters (required_parameter type: (type_annotation (_) @type_ref))))
  (function_declaration
    name: (identifier) @owner_name
    return_type: (type_annotation (_) @type_ref))
`;

const JAVA_TYPE_REF_QUERY = `
  (field_declaration
    type: (_) @type_ref
    declarator: (variable_declarator name: (identifier) @owner_field))
  (method_declaration
    type: (_) @type_ref
    name: (identifier) @owner_name)
  (method_declaration
    name: (identifier) @owner_name
    parameters: (formal_parameters (formal_parameter type: (_) @type_ref)))
`;

const CPP_TYPE_REF_QUERY = `
  (field_declaration
    type: (_) @type_ref
    declarator: (field_identifier) @owner_field)
  (field_declaration
    type: (_) @type_ref
    declarator: (reference_declarator (field_identifier) @owner_field))
  (field_declaration
    type: (_) @type_ref
    declarator: (pointer_declarator declarator: (field_identifier) @owner_field))
  (function_definition
    type: (_) @type_ref
    declarator: (function_declarator declarator: (identifier) @owner_name))
`;

// ============================================================
// LANGUAGE CONFIGURATIONS
// ============================================================

// Eine Out-of-line-Definition in einem Namensraum ist KEIN qualified_identifier
// mit drei Feldern, sondern eine Kette: `ns::Cls::run` ist
// qualified_identifier(scope ns, name qualified_identifier(scope Cls, name run)).
// Das einstufige Muster verlangt `name: (identifier)` und passt deshalb nur auf
// `Cls::run`. Jede Methode eines Projekts, das seine Klassen in einen Namensraum
// legt — also praktisch jedes ROS-Paket — verschwand damit vollständig aus dem
// Graphen: kein Function-Knoten, keine CONTAINS-Kante, ein leeres Kästchen.
// Tree-sitter kennt keinen Nachfahren-Operator, die Schachtelung muss also
// ausgeschrieben werden. @func_scope sitzt jeweils auf dem INNERSTEN scope —
// das ist die Klasse, nicht der äußere Namensraum, und nur die kann
// linkOutOfLineMethods auflösen. Zwei bzw. drei Ebenen decken `ns::Cls::m` und
// `a::b::Cls::m` ab; tiefere Verschachtelung bleibt eine bekannte Lücke.
//
// Die beiden field_declaration_list-Muster holen die DEKLARIERTEN Member: im
// Header steht die Klasse mit ihren Methoden, die Rumpfe stehen in der .cpp —
// und ein function_definition ist das nur MIT Rumpf. Ohne sie hatte jede Klasse,
// die man im Header ansieht, null Methoden. Die Verankerung an
// field_declaration_list ist Absicht: dieselbe Form außerhalb eines
// Klassenrumpfs ist der Most-Vexing-Parse (`Widget w(1);` ist syntaktisch ein
// function_declarator) und würde Variablen als Funktionen erfinden.
// Konstruktor und Destruktor sind `declaration` statt `field_declaration`, weil
// sie keinen Rückgabetyp tragen — daher ein eigenes Muster.
//
// `destructor_name` und `operator_name` gehören überall dort in die
// Alternative, wo `identifier` steht. Ein Destruktor heißt in der Grammatik
// nicht identifier, und `virtual ~A() = default;` ist außerdem ein
// function_definition (die `= default`-Klausel zählt als Rumpf) — beides
// zusammen liess Destruktoren und Operatoren restlos aus dem Diagramm fallen,
// obwohl `~A()` und `operator=` das sind, was eine C++-Klasse mit eigener
// Ressourcenverwaltung ausmacht.
const CPP_FUNC_QUERY = `
  (function_definition
    declarator: (function_declarator
      declarator: [(identifier) (destructor_name) (operator_name)] @func_name
      parameters: (parameter_list) @params))
  (function_definition
    declarator: (function_declarator
      declarator: (field_identifier) @func_name
      parameters: (parameter_list) @params))
  (function_definition
    declarator: (function_declarator
      declarator: (qualified_identifier
        scope: [(namespace_identifier) (type_identifier) (template_type)] @func_scope
        name: [(identifier) (destructor_name) (operator_name)] @func_name)
      parameters: (parameter_list) @params))
  (function_definition
    declarator: (pointer_declarator
      declarator: (function_declarator
        declarator: (identifier) @func_name
        parameters: (parameter_list) @params)))
  (function_definition
    declarator: (reference_declarator
      (function_declarator
        declarator: (identifier) @func_name
        parameters: (parameter_list) @params)))

  ; Beliebig tiefe Qualifizierung, mit EINEM Muster.
  ;
  ; Vorher stand die Schachtelung ausgeschrieben da, einmal für zwei und einmal
  ; für drei Ebenen, und jede weitere hätte einen weiteren Block gekostet.
  ; Eine Definition wie void a..b..c..Cls..m() -- mit den üblichen zwei
  ; Doppelpunkten -- fiel deshalb komplett aus dem Graphen. In einem ROS-Paket,
  ; das seine Klassen in paket..modul..sensor legt, ist das der Normalfall und
  ; kein Randfall.
  ;
  ; Statt die Baumform nachzubauen wird der ganze qualifizierte Name erfasst
  ; und in extractFunctions zerlegt: der letzte Abschnitt ist die Methode, der
  ; vorletzte die Klasse. Das ist dieselbe Regel, die scopeOwner ohnehin
  ; anwendet, und sie kennt keine Tiefengrenze.
  (function_definition
    declarator: (function_declarator
      declarator: (qualified_identifier) @qualified_name
      parameters: (parameter_list) @params))
  (function_definition
    declarator: (pointer_declarator
      declarator: (function_declarator
        declarator: (qualified_identifier) @qualified_name
        parameters: (parameter_list) @params)))

  (field_declaration_list
    (field_declaration
      declarator: [
        (function_declarator
          declarator: [(field_identifier) (operator_name)] @func_name
          parameters: (parameter_list) @params)
        (pointer_declarator
          declarator: (function_declarator
            declarator: [(field_identifier) (operator_name)] @func_name
            parameters: (parameter_list) @params))
        (reference_declarator
          (function_declarator
            declarator: [(field_identifier) (operator_name)] @func_name
            parameters: (parameter_list) @params))
      ]))
  (field_declaration_list
    (declaration
      declarator: (function_declarator
        declarator: [(identifier) (destructor_name) (operator_name)] @func_name
        parameters: (parameter_list) @params)))
`;

const CPP_CALL_QUERY = `
  (call_expression function: (identifier) @call_target)
  (call_expression function: (field_expression argument: (_) @call_object field: (field_identifier) @call_target))
  (call_expression function: (qualified_identifier scope: (_) @call_object name: (identifier) @call_target))
`;

// `body:` ist nicht Kosmetik, sondern die Bedingung dafür, dass hier eine
// DEFINITION steht. In C und C++ ist `struct Node*` als Feldtyp, `struct Foo* p`
// als Parameter und `class Fwd;` als Vorwärtsdeklaration alles derselbe
// Knotentyp wie die Definition, nur ohne Rumpf. Ohne die Einschraenkung entstand
// pro Erwähnung ein Class-Knoten — und weil extractClasses jedes Mal
// `SET cls.startLine/endLine` schreibt, überschrieb die LETZTE Erwähnung den
// echten Zeilenbereich: `struct Node { struct Node* next; };` landete im Graphen
// als Klasse Node in Zeile 2 bis 2. Zusätzlich gewann so eine blosse
// Vorwärtsdeklaration bei resolveClassCandidate die "same file"-Runde gegen die
// echte Klasse in der Nachbardatei.
const CPP_CLASS_QUERY = `
  (class_specifier name: (type_identifier) @class_name body: (field_declaration_list))
  (struct_specifier name: (type_identifier) @class_name body: (field_declaration_list))
  (type_definition type: (struct_specifier !name body: (field_declaration_list)) @class_node
    declarator: (type_identifier) @class_name)
  (enum_specifier name: (type_identifier) @class_name body: (enumerator_list))
`;

// Nur quoted includes sind belastbare Projektbezüge. Die Grammatik trennt
// `"foo.h"` als string_literal von `<vector>` als system_lib_string; würden
// wir beide capturen, entstuenden für Standardbibliotheken scheinbar lokale
// IMPORTS-Kanten. resolveImportPath löst quoted Header relativ zur Quelldatei.
const C_INCLUDE_QUERY = `(preproc_include path: (string_literal) @import_source)`;

const C_ALIAS_QUERY = `
  (init_declarator declarator: (identifier) @alias_name value: (identifier) @original_name)
  (assignment_expression left: (identifier) @alias_name right: (identifier) @original_name)
`;

const C_CALLBACK_QUERY = `
  (call_expression function: (identifier) @caller_func
    arguments: (argument_list (identifier) @callback_ref))
  (call_expression function: (identifier) @caller_func
    arguments: (argument_list (pointer_expression "&" argument: (identifier) @callback_ref)))
`;

const C_CONDITIONAL_CALL_QUERY = `
  (if_statement condition: (_) @condition consequence: (_) @then_branch alternative: (_)? @else_branch)
  (conditional_expression condition: (_) @tern_condition consequence: (_) @tern_then alternative: (_) @tern_else)
`;

const C_CONTROL_FLOW_QUERY = `
  (if_statement) @if_stmt
  (for_statement) @for_stmt
  (while_statement) @while_stmt
  (do_statement) @do_while_stmt
  (switch_statement) @switch_stmt
`;

const C_STATEMENT_QUERY = `
  (return_statement) @return_stmt
  (break_statement) @break_stmt
  (continue_statement) @continue_stmt
  (goto_statement) @goto_stmt
`;

// Pointer-Deklaratoren brauchen ein eigenes Muster; der Capture sitzt trotzdem
// auf dem identifier, damit der Graph `pointer` statt des Syntaxtexts `*pointer`
// als Variablennamen speichert.
//
// Die vier @field_name-Muster sind das Attributfach des Klassendiagramms. Ein
// Member steht in C und C++ als `field_declaration` mit einem `field_identifier`
// da — nicht als init_declarator und nicht als identifier. Ohne sie hatte JEDE
// C- und C++-Klasse null Attribute: `struct Ops { int flags; }` wurde ein leeres
// Kästchen, obwohl die Struktur aus nichts anderem besteht. (Java kommt über
// variable_declarator herein und war deshalb nie betroffen.)
//
// Der Zeiger auf eine Funktion (`int (*init)(void);`) ist bewusst ein FELD und
// keine Methode: syntaktisch ist er ein Datenmember, und ob dahinter eine
// vtable-Konvention steckt, kann nur eine Datenflussanalyse entscheiden. Sein
// Deklarator ist dreifach verschachtelt (function_declarator ->
// parenthesized_declarator -> pointer_declarator) und braucht deshalb ein
// eigenes Muster; das Muster für Methoden in CPP_FUNC_QUERY verlangt dagegen
// einen field_identifier direkt am function_declarator und greift hier nicht.
const C_VARIABLE_QUERY = `
  (init_declarator declarator: (identifier) @var_name)
  (init_declarator declarator: (pointer_declarator declarator: (identifier) @var_name))
  (parameter_declaration declarator: (identifier) @param_name)
  (parameter_declaration declarator: (pointer_declarator declarator: (identifier) @param_name))
  (field_declaration declarator: (field_identifier) @field_name)
  (field_declaration declarator: (pointer_declarator declarator: (field_identifier) @field_name))
  (field_declaration declarator: (array_declarator declarator: (field_identifier) @field_name))
  (field_declaration
    declarator: (function_declarator
      declarator: (parenthesized_declarator
        (pointer_declarator declarator: (field_identifier) @field_name))))
`;

const CPP_VARIABLE_QUERY = `${C_VARIABLE_QUERY}
  (enum_specifier name: (type_identifier)
    body: (enumerator_list (enumerator name: (identifier) @field_name)))
  (init_declarator declarator: (reference_declarator (identifier) @var_name))
  (parameter_declaration declarator: (reference_declarator (identifier) @param_name))
  (field_declaration declarator: (reference_declarator (field_identifier) @field_name))
`;

const C_AST_QUERY = `
  (binary_expression) @BinaryExpression
  (assignment_expression) @AssignmentExpression
  (field_expression) @MemberExpression
  (subscript_expression) @SubscriptExpression
  (conditional_expression) @TernaryExpression
  (unary_expression) @UnaryExpression
  (update_expression) @UpdateExpression
  (call_expression) @CallExpression
  (string_literal) @StringLiteral
  (number_literal) @NumberLiteral
  (initializer_list) @ArrayExpression
`;

const CPP_ASYNC_QUERY = `
  (co_await_expression argument: (call_expression function: (identifier) @await_target))
  (co_await_expression argument: (call_expression function: (field_expression field: (field_identifier) @await_target)))
  (co_await_expression argument: (call_expression function: (qualified_identifier name: (identifier) @await_target)))
`;

const CPP_LANG_CONFIG = {
  wasm: '../node_modules/tree-sitter-cpp/tree-sitter-cpp.wasm',
  funcQuery: CPP_FUNC_QUERY,
  callQuery: CPP_CALL_QUERY,
  classQuery: CPP_CLASS_QUERY,
  stateQuery: null,
  returnQuery: `(return_statement (_) @return_expr)`,
  importQuery: C_INCLUDE_QUERY,
  requireQuery: null,
  jsxQuery: null,
  jsxComponentQuery: null,
  jsxPropQuery: null,
  httpQuery: null,
  hookEffectQuery: null,
  classInheritanceQuery: CPP_CLASS_INHERITANCE_QUERY,
  rosInterfaceQuery: CPP_ROS_INTERFACE_QUERY,
  rosNodeNameQuery: CPP_ROS_NODE_NAME_QUERY,
  rosLang: 'cpp',
  instantiationQuery: CPP_NEW_QUERY,
  // `using` importiert keinen Dateipfad und `extern` benennt keine exportierende
  // Datei. namedImport/namedExport bleiben deshalb bewusst unmodelliert.
  namedImportQuery: null,
  namedExportQuery: null,
  aliasQuery: C_ALIAS_QUERY,
  callbackQuery: C_CALLBACK_QUERY,
  conditionalCallQuery: C_CONDITIONAL_CALL_QUERY,
  // std::async/std::future sind Bibliothekskonventionen; nur co_await ist ein
  // eindeutiges Sprachkonstrukt und darf daher eine AWAITS-Kante erzeugen.
  asyncChainQuery: CPP_ASYNC_QUERY,
  controlFlowQuery: C_CONTROL_FLOW_QUERY,
  statementQuery: C_STATEMENT_QUERY,
  variableQuery: CPP_VARIABLE_QUERY,
  typeRefQuery: CPP_TYPE_REF_QUERY,
  astQuery: C_AST_QUERY
};

const C_FUNC_QUERY = `
  (function_definition
    declarator: (function_declarator
      declarator: (identifier) @func_name
      parameters: (parameter_list) @params))
  (function_definition
    declarator: (pointer_declarator
      declarator: (function_declarator
        declarator: (identifier) @func_name
        parameters: (parameter_list) @params)))
`;

const C_LANG_CONFIG = {
  wasm: '../node_modules/tree-sitter-c/tree-sitter-c.wasm',
  funcQuery: C_FUNC_QUERY,
  callQuery: `(call_expression function: (identifier) @call_target)`,
  // Wie bei C++: nur eine Definition mit Rumpf ist eine Klasse. `struct Node*
  // next;` und `void f(struct Foo* p)` sind Erwähnungen, und jede von ihnen
  // überschrieb sonst den Zeilenbereich der echten Struktur.
  classQuery: `
    (struct_specifier name: (type_identifier) @class_name body: (field_declaration_list))
    (type_definition type: (struct_specifier !name body: (field_declaration_list)) @class_node
      declarator: (type_identifier) @class_name)
  `,
  stateQuery: null,
  returnQuery: `(return_statement (_) @return_expr)`,
  importQuery: C_INCLUDE_QUERY,
  requireQuery: null,
  jsxQuery: null,
  jsxComponentQuery: null,
  jsxPropQuery: null,
  httpQuery: null,
  hookEffectQuery: null,
  classInheritanceQuery: null,
  instantiationQuery: null,
  namedImportQuery: null,
  namedExportQuery: null,
  aliasQuery: C_ALIAS_QUERY,
  callbackQuery: C_CALLBACK_QUERY,
  conditionalCallQuery: C_CONDITIONAL_CALL_QUERY,
  // C besitzt kein Sprachkonstrukt für Await/Spawn; Bibliotheksaufrufe wie
  // pthread_create dürfen ohne Typ- und Datenflussanalyse nicht geraten werden.
  asyncChainQuery: null,
  controlFlowQuery: C_CONTROL_FLOW_QUERY,
  statementQuery: C_STATEMENT_QUERY,
  variableQuery: C_VARIABLE_QUERY,
  typeRefQuery: CPP_TYPE_REF_QUERY,
  astQuery: C_AST_QUERY
};

const GO_NAMED_IMPORT_QUERY = `
  (import_spec
    name: (package_identifier) @import_name
    path: (interpreted_string_literal) @import_source)
`;

const GO_NAMED_EXPORT_QUERY = `
  (function_declaration name: (identifier) @export_name
    (#match? @export_name "^[A-Z]"))
  (type_spec name: (type_identifier) @export_name
    (#match? @export_name "^[A-Z]"))
`;

const GO_ALIAS_QUERY = `
  (short_var_declaration
    left: (expression_list (identifier) @alias_name)
    right: (expression_list (identifier) @original_name))
  (assignment_statement
    left: (expression_list (identifier) @alias_name)
    right: (expression_list (identifier) @original_name))
`;

const GO_CALLBACK_QUERY = `
  (call_expression
    function: (identifier) @caller_func
    arguments: (argument_list (identifier) @callback_ref))
  (call_expression
    function: (selector_expression field: (field_identifier) @caller_method)
    arguments: (argument_list (identifier) @callback_ref))
`;

const GO_CONDITIONAL_CALL_QUERY = `
  (if_statement
    condition: (_) @condition
    consequence: (block) @then_branch
    alternative: (_)? @else_branch)
`;

const GO_ASYNC_QUERY = `
  (go_statement
    (call_expression function: (identifier) @spawn_target))
  (go_statement
    (call_expression
      function: (selector_expression field: (field_identifier) @spawn_target)))
`;

const GO_EMBEDDING_QUERY = `
  (type_declaration
    (type_spec
      name: (type_identifier) @class_name
      type: (struct_type
        (field_declaration_list
          (field_declaration
            type: (type_identifier) @base_class
            !name)))))
`;

const GO_INSTANTIATION_QUERY = `
  (composite_literal type: (type_identifier) @class_name)
  (composite_literal type: (qualified_type) @class_name)
`;

const GO_CONTROL_FLOW_QUERY = `
  (if_statement) @if_stmt
  (for_statement) @for_stmt
  (expression_switch_statement) @switch_stmt
  (type_switch_statement) @switch_stmt
  (select_statement) @switch_stmt
`;

const GO_STATEMENT_QUERY = `
  (return_statement) @return_stmt
  (break_statement) @break_stmt
  (continue_statement) @continue_stmt
`;

const GO_VARIABLE_QUERY = `
  (short_var_declaration left: (expression_list (identifier) @var_name))
  (var_spec name: (identifier) @var_name)
  (const_spec name: (identifier) @var_name)
  (parameter_declaration name: (identifier) @param_name)
`;

const GO_AST_QUERY = `
  (binary_expression) @BinaryExpression
  (assignment_statement) @AssignmentExpression
  (selector_expression) @MemberExpression
  (index_expression) @SubscriptExpression
  (unary_expression) @UnaryExpression
  (composite_literal) @ObjectExpression
  (interpreted_string_literal) @StringLiteral
  (raw_string_literal) @StringLiteral
  (int_literal) @NumberLiteral
  (float_literal) @NumberLiteral
`;

// Queries below validated against the bundled WASM grammars via
// scripts/_validate_lang_queries.js. funcQuery/callQuery must stay valid —
// they are compiled with `new Query` (not safeQuery) and would crash the build.
const GO_LANG_CONFIG = {
  wasm: '../node_modules/tree-sitter-go/tree-sitter-go.wasm',
  funcQuery: `
    (function_declaration name: (identifier) @func_name parameters: (parameter_list) @params)
    (method_declaration name: (field_identifier) @func_name parameters: (parameter_list) @params)
  `,
  callQuery: `
    (call_expression function: (identifier) @call_target)
    (call_expression function: (selector_expression operand: (_) @call_object field: (field_identifier) @call_target))
  `,
  classQuery: `(type_declaration (type_spec name: (type_identifier) @class_name type: (struct_type)))`,
  stateQuery: null,
  returnQuery: `(return_statement (_) @return_expr)`,
  importQuery: `(import_spec path: (interpreted_string_literal) @import_source)`,
  requireQuery: null,
  jsxQuery: null, jsxComponentQuery: null, jsxPropQuery: null,
  httpQuery: null, hookEffectQuery: null,
  // Go kennt keine deklarierte Vererbung. Struct-Embedding ist aber eine
  // explizite Kompositionsbeziehung mit Methoden-Promotion und damit das
  // einzige syntaktisch belastbare Aequivalent; Interface-Erfüllung kann nur
  // eine spätere Typanalyse korrekt bestimmen.
  classInheritanceQuery: GO_EMBEDDING_QUERY,
  instantiationQuery: GO_INSTANTIATION_QUERY,
  aliasQuery: GO_ALIAS_QUERY,
  callbackQuery: GO_CALLBACK_QUERY,
  conditionalCallQuery: GO_CONDITIONAL_CALL_QUERY,
  // `go f()` wartet nicht, sondern startet nebenläufige Arbeit. Der eigene
  // Capture-Name sorgt dafür, dass der Async-Extraktor SPAWNS statt der
  // semantisch gegenteiligen AWAITS-Kante schreibt.
  asyncChainQuery: GO_ASYNC_QUERY,
  namedImportQuery: GO_NAMED_IMPORT_QUERY,
  namedExportQuery: GO_NAMED_EXPORT_QUERY,
  controlFlowQuery: GO_CONTROL_FLOW_QUERY,
  statementQuery: GO_STATEMENT_QUERY,
  variableQuery: GO_VARIABLE_QUERY,
  astQuery: GO_AST_QUERY
};

const RUST_NAMED_IMPORT_QUERY = `
  (use_declaration
    argument: (scoped_identifier
      name: (identifier) @import_name) @import_source)
  (use_declaration
    argument: (use_as_clause
      path: (scoped_identifier name: (identifier) @import_name) @import_source
      alias: (identifier) @import_alias))
`;

const RUST_NAMED_EXPORT_QUERY = `
  (function_item
    (visibility_modifier)
    name: (identifier) @export_name)
  (struct_item
    (visibility_modifier)
    name: (type_identifier) @export_name)
  (enum_item
    (visibility_modifier)
    name: (type_identifier) @export_name)
`;

const RUST_IMPL_TRAIT_QUERY = `
  (impl_item
    trait: [(type_identifier) (scoped_type_identifier) (generic_type)] @base_class
    type: (type_identifier) @class_name)
`;

const RUST_INSTANTIATION_QUERY = `
  (struct_expression name: [(type_identifier) (scoped_type_identifier)] @class_name)
`;

const RUST_ALIAS_QUERY = `
  (let_declaration
    pattern: (identifier) @alias_name
    value: (identifier) @original_name)
`;

const RUST_CALLBACK_QUERY = `
  (call_expression
    function: (identifier) @caller_func
    arguments: (arguments (identifier) @callback_ref))
  (call_expression
    function: (field_expression field: (field_identifier) @caller_method)
    arguments: (arguments (identifier) @callback_ref))
`;

const RUST_CONDITIONAL_CALL_QUERY = `
  (if_expression
    condition: (_) @condition
    consequence: (block) @then_branch
    alternative: (_)? @else_branch)
`;

const RUST_ASYNC_CHAIN_QUERY = `
  (await_expression
    (call_expression function: (identifier) @await_target))
  (await_expression
    (call_expression function: (field_expression field: (field_identifier) @await_target)))
`;

const RUST_CONTROL_FLOW_QUERY = `
  (if_expression) @if_stmt
  (for_expression) @for_stmt
  (while_expression) @while_stmt
  (loop_expression) @while_stmt
  (match_expression) @switch_stmt
`;

const RUST_STATEMENT_QUERY = `
  (return_expression) @return_stmt
  (break_expression) @break_stmt
  (continue_expression) @continue_stmt
`;

const RUST_VARIABLE_QUERY = `
  (let_declaration pattern: (identifier) @var_name)
  (parameter pattern: (identifier) @param_name)
`;

const RUST_AST_QUERY = `
  (binary_expression) @BinaryExpression
  (assignment_expression) @AssignmentExpression
  (compound_assignment_expr) @AugmentedAssignment
  (field_expression) @MemberExpression
  (index_expression) @SubscriptExpression
  (unary_expression) @UnaryExpression
  (closure_expression) @ArrowFunction
  (call_expression) @CallExpression
  (await_expression) @AwaitExpression
  (string_literal) @StringLiteral
  (integer_literal) @NumberLiteral
  (float_literal) @NumberLiteral
  (array_expression) @ArrayExpression
`;

const RUST_LANG_CONFIG = {
  wasm: '../node_modules/tree-sitter-rust/tree-sitter-rust.wasm',
  funcQuery: `(function_item name: (identifier) @func_name parameters: (parameters) @params)`,
  callQuery: `
    (call_expression function: (identifier) @call_target)
    (call_expression function: (field_expression value: (_) @call_object field: (field_identifier) @call_target))
    (call_expression function: (scoped_identifier path: (_) @call_object name: (identifier) @call_target))
  `,
  classQuery: `
    (struct_item name: (type_identifier) @class_name)
    (enum_item name: (type_identifier) @class_name)
  `,
  stateQuery: null,
  returnQuery: `(return_expression (_) @return_expr)`,
  importQuery: `(use_declaration argument: (scoped_identifier) @import_source)`,
  requireQuery: null,
  jsxQuery: null, jsxComponentQuery: null, jsxPropQuery: null,
  httpQuery: null, hookEffectQuery: null,
  // `impl Trait for Type` ist Rusts explizite Implementierungsbeziehung. Ein
  // inhärentes `impl Type` enthält keinen Trait und darf keine INHERITS-Kante
  // vortaeuschen.
  classInheritanceQuery: RUST_IMPL_TRAIT_QUERY,
  instantiationQuery: RUST_INSTANTIATION_QUERY,
  aliasQuery: RUST_ALIAS_QUERY,
  callbackQuery: RUST_CALLBACK_QUERY,
  conditionalCallQuery: RUST_CONDITIONAL_CALL_QUERY,
  asyncChainQuery: RUST_ASYNC_CHAIN_QUERY,
  namedImportQuery: RUST_NAMED_IMPORT_QUERY,
  namedExportQuery: RUST_NAMED_EXPORT_QUERY,
  controlFlowQuery: RUST_CONTROL_FLOW_QUERY,
  statementQuery: RUST_STATEMENT_QUERY,
  variableQuery: RUST_VARIABLE_QUERY,
  astQuery: RUST_AST_QUERY
};

const JAVA_NAMED_IMPORT_QUERY = `
  (import_declaration
    (scoped_identifier name: (identifier) @import_name) @import_source)
`;

const JAVA_NAMED_EXPORT_QUERY = `
  (method_declaration
    (modifiers "public")
    name: (identifier) @export_name)
  (class_declaration
    (modifiers "public")
    name: (identifier) @export_name)
  (interface_declaration
    (modifiers "public")
    name: (identifier) @export_name)
`;

const JAVA_ALIAS_QUERY = `
  (local_variable_declaration
    declarator: (variable_declarator
      name: (identifier) @alias_name
      value: (identifier) @original_name))
  (assignment_expression
    left: (identifier) @alias_name
    right: (identifier) @original_name)
`;

const JAVA_CALLBACK_QUERY = `
  (method_invocation
    name: (identifier) @caller_method
    arguments: (argument_list (identifier) @callback_ref))
`;

const JAVA_CONDITIONAL_CALL_QUERY = `
  (if_statement
    condition: (_) @condition
    consequence: (_) @then_branch
    alternative: (_)? @else_branch)
  (ternary_expression
    condition: (_) @tern_condition
    consequence: (_) @tern_then
    alternative: (_) @tern_else)
`;

const JAVA_CONTROL_FLOW_QUERY = `
  (if_statement) @if_stmt
  (for_statement) @for_stmt
  (enhanced_for_statement) @for_in_stmt
  (while_statement) @while_stmt
  (do_statement) @do_while_stmt
  (switch_expression) @switch_stmt
  (try_statement) @try_stmt
`;

const JAVA_STATEMENT_QUERY = `
  (return_statement) @return_stmt
  (throw_statement) @throw_stmt
  (break_statement) @break_stmt
  (continue_statement) @continue_stmt
`;

const JAVA_VARIABLE_QUERY = `
  (variable_declarator name: (identifier) @var_name)
  (formal_parameter name: (identifier) @param_name)
  (spread_parameter (variable_declarator name: (identifier) @param_name))
`;

const JAVA_AST_QUERY = `
  (binary_expression) @BinaryExpression
  (assignment_expression) @AssignmentExpression
  (field_access) @MemberExpression
  (array_access) @SubscriptExpression
  (ternary_expression) @TernaryExpression
  (unary_expression) @UnaryExpression
  (update_expression) @UpdateExpression
  (object_creation_expression) @NewExpression
  (lambda_expression) @ArrowFunction
  (method_invocation) @CallExpression
  (string_literal) @StringLiteral
  (decimal_integer_literal) @NumberLiteral
  (decimal_floating_point_literal) @NumberLiteral
  (array_initializer) @ArrayExpression
`;

const JAVA_LANG_CONFIG = {
  wasm: '../node_modules/tree-sitter-java/tree-sitter-java.wasm',
  // Ein Konstruktor ist keine method_declaration, sondern eine eigene
  // Knotenart. Ohne das zweite Muster fehlte in jedem Java-Klassendiagramm
  // genau die Methode, die sagt, WIE man ein Objekt der Klasse bekommt.
  funcQuery: `
    (method_declaration name: (identifier) @func_name parameters: (formal_parameters) @params)
    (constructor_declaration name: (identifier) @func_name parameters: (formal_parameters) @params)
  `,
  callQuery: `
    (method_invocation !object name: (identifier) @call_target)
    (method_invocation object: (_) @call_object name: (identifier) @call_target)
  `,
  // Interface, enum und record sind in Java eigene Deklarationsarten, im
  // Klassendiagramm aber genauso Kästchen wie eine Klasse. Mit nur
  // class_declaration entstand für sie kein Knoten: ihre Methoden hingen als
  // freie Funktionen in der Datei, ein `implements Runner` auf ein Interface
  // DERSELBEN Datei wurde als <<external>> gezeichnet, und ein Record hatte
  // überhaupt kein Kästchen. (Rust listet aus demselben Grund enum_item als
  // Klasse.)
  classQuery: `
    (class_declaration name: (identifier) @class_name)
    (interface_declaration name: (identifier) @class_name)
    (enum_declaration name: (identifier) @class_name)
    (record_declaration name: (identifier) @class_name)
  `,
  stateQuery: null,
  returnQuery: `(return_statement (_) @return_expr)`,
  importQuery: `(import_declaration (scoped_identifier) @import_source)`,
  requireQuery: null,
  jsxQuery: null, jsxComponentQuery: null, jsxPropQuery: null,
  httpQuery: null, hookEffectQuery: null, classInheritanceQuery: JAVA_CLASS_INHERITANCE_QUERY,
  instantiationQuery: JAVA_NEW_QUERY,
  aliasQuery: JAVA_ALIAS_QUERY,
  callbackQuery: JAVA_CALLBACK_QUERY,
  conditionalCallQuery: JAVA_CONDITIONAL_CALL_QUERY,
  // Java hat kein Sprachkonstrukt für await oder Promise-Ketten. APIs wie
  // CompletableFuture.thenApply sind normale Methodenaufrufe und dürfen ohne
  // Datenflussanalyse nicht pauschal als AWAITS modelliert werden.
  asyncChainQuery: null,
  namedImportQuery: JAVA_NAMED_IMPORT_QUERY,
  namedExportQuery: JAVA_NAMED_EXPORT_QUERY,
  controlFlowQuery: JAVA_CONTROL_FLOW_QUERY,
  statementQuery: JAVA_STATEMENT_QUERY,
  variableQuery: JAVA_VARIABLE_QUERY,
  typeRefQuery: JAVA_TYPE_REF_QUERY,
  astQuery: JAVA_AST_QUERY
};

const RUBY_LANG_CONFIG = {
  wasm: '../node_modules/tree-sitter-ruby/tree-sitter-ruby.wasm',
  funcQuery: `
    (method name: (identifier) @func_name) @func_node
    (singleton_method object: [(self) (constant)] name: (identifier) @func_name) @func_node
  `,
  // Only the explicit call form — Ruby paren-less calls parse as bare
  // identifiers and matching those would produce false positives.
  callQuery: `
    (call !receiver method: (identifier) @call_target)
    (call receiver: (_) @call_object method: (identifier) @call_target)
  `,
  classQuery: `(class name: (constant) @class_name)`,
  stateQuery: null,
  returnQuery: `(return (_) @return_expr)`,
  importQuery: `
    (call
      method: (identifier) @import_command
      arguments: (argument_list (string) @import_source)
      (#match? @import_command "^(require|require_relative)$"))
  `,
  requireQuery: null,
  jsxQuery: null, jsxComponentQuery: null, jsxPropQuery: null,
  httpQuery: null, hookEffectQuery: null, classInheritanceQuery: RUBY_CLASS_INHERITANCE_QUERY,
  controlFlowQuery: null, statementQuery: null, variableQuery: null, astQuery: null
};

const KOTLIN_LANG_CONFIG = {
  wasm: '../node_modules/tree-sitter-wasm/out/kotlin/tree-sitter-kotlin.wasm',
  funcQuery: `
    (function_declaration
      (simple_identifier) @func_name
      (function_value_parameters) @params) @func_node
  `,
  callQuery: `
    (call_expression (simple_identifier) @call_target)
    (call_expression
      (navigation_expression
        (simple_identifier) @call_object
        (navigation_suffix (simple_identifier) @call_target)))
  `,
  classQuery: `(class_declaration (type_identifier) @class_name)`,
  returnQuery: `(jump_expression (_) @return_expr)`,
  importQuery: `(import_header (identifier) @import_source)`,
  classInheritanceQuery: `
    (class_declaration
      (type_identifier) @class_name
      (delegation_specifier
        (constructor_invocation
          (user_type) @base_class)))
    (class_declaration
      (type_identifier) @class_name
      (delegation_specifier
        (user_type) @base_class))
    (class_declaration
      (type_identifier) @class_name
      (delegation_specifier
        (explicit_delegation (user_type) @base_class)))
  `,
  astQuery: `
    (additive_expression) @BinaryExpression
    (multiplicative_expression) @BinaryExpression
    (comparison_expression) @ComparisonExpression
    (equality_expression) @ComparisonExpression
    (assignment) @AssignmentExpression
    (navigation_expression) @MemberExpression
    (call_expression) @CallExpression
    (string_literal) @StringLiteral
    (integer_literal) @NumberLiteral
    (lambda_literal) @ArrowFunction
    (collection_literal) @ArrayExpression
  `
};

const BASH_LANG_CONFIG = {
  wasm: '../node_modules/tree-sitter-wasm/out/bash/tree-sitter-bash.wasm',
  funcQuery: `(function_definition name: (word) @func_name body: (_) @func_node)`,
  callQuery: `(command name: (command_name (word) @call_target))`,
  importQuery: `
    (command
      name: (command_name (word) @import_command)
      argument: [(word) (string) (raw_string)] @import_source
      (#match? @import_command "^(source|\\.)$"))
  `,
  astQuery: `
    (binary_expression) @BinaryExpression
    (variable_assignment) @AssignmentExpression
    (command_substitution) @CallExpression
    (string) @StringLiteral
    (raw_string) @StringLiteral
  `
};

const LUA_LANG_CONFIG = {
  wasm: '../node_modules/tree-sitter-wasm/out/lua/tree-sitter-lua.wasm',
  funcQuery: `
    (function_declaration name: (identifier) @func_name parameters: (parameters) @params) @func_node
    (function_declaration name: (method_index_expression) @func_name parameters: (parameters) @params) @func_node
  `,
  callQuery: `
    (function_call name: (identifier) @call_target)
    (function_call name: (dot_index_expression table: (identifier) @call_object field: (identifier) @call_target))
    (function_call name: (method_index_expression table: (identifier) @call_object method: (identifier) @call_target))
  `,
  importQuery: `
    (function_call
      name: (identifier) @import_function
      arguments: (arguments (string content: (string_content) @import_source))
      (#eq? @import_function "require"))
  `,
  astQuery: `
    (binary_expression) @BinaryExpression
    (assignment_statement) @AssignmentExpression
    (dot_index_expression) @MemberExpression
    (method_index_expression) @MemberExpression
    (function_call) @CallExpression
    (string) @StringLiteral
    (number) @NumberLiteral
    (table_constructor) @ObjectExpression
  `
};

// The XML grammar shipped by tree-sitter-wasm currently traps in Wasmtime for
// ordinary Android manifests. HTML uses the same element/attribute model and
// parses XML-compatible Android resources losslessly, so it is the safer parser
// until the upstream XML artifact is fixed.
const XML_LANG_CONFIG = {
  wasm: '../node_modules/tree-sitter-wasm/out/html/tree-sitter-html.wasm',
  funcQuery: null,
  callQuery: null,
  astQuery: `
    (element) @XMLElement
    (attribute) @XMLAttribute
  `
};

function kotlinFunctionSemantics(source, funcName) {
  const prefix = String(source || '').slice(0, Math.max(0, String(source || '').indexOf('fun')));
  const isOverride = /\boverride\b/.test(prefix);
  const annotationEntrypoint = /@(Composable|JavascriptInterface|ReactMethod|JvmStatic)\b/.test(prefix);
  const androidLifecycle = isOverride && /^(onCreate|onStart|onResume|onPause|onStop|onDestroy|onActivityResult|onRequestPermissionsResult|onNewIntent|onCreateView|onViewCreated|onReceive|doWork)$/.test(funcName);
  return {
    isOverride,
    isFrameworkEntrypoint: Boolean(isOverride || annotationEntrypoint || androidLifecycle),
    entryPointKind: androidLifecycle ? 'android-lifecycle'
      : annotationEntrypoint ? 'framework-annotation'
        : isOverride ? 'interface-override' : null,
    visibility: ((/\b(private|protected|internal|public)\b/.exec(prefix) || [])[1] || 'public'),
  };
}

function kotlinReceiverTypes(source) {
  const result = new Map();
  for (const match of String(source || '').matchAll(/\b(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Z][A-Za-z0-9_.]*)/g)) {
    result.set(match[1], match[2].split('.').pop());
  }
  for (const match of String(source || '').matchAll(/\b([a-z_][A-Za-z0-9_]*)\s*:\s*([A-Z][A-Za-z0-9_.]*)/g)) {
    if (!result.has(match[1])) result.set(match[1], match[2].split('.').pop());
  }
  for (const match of String(source || '').matchAll(/\b(?:val|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([A-Z][A-Za-z0-9_.]*)\s*\(/g)) {
    if (!result.has(match[1])) result.set(match[1], match[2].split('.').pop());
  }
  return result;
}

function jsTsReceiverTypes(source) {
  const result = new Map();
  const ambiguous = new Set();
  const record = (name, type) => {
    if (ambiguous.has(name)) return;
    if (result.has(name) && result.get(name) !== type) {
      result.delete(name);
      ambiguous.add(name);
      return;
    }
    result.set(name, type);
  };
  const text = String(source || '');
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g)) record(m[1], m[2]);
  for (const m of text.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:useMemo|useRef|useState)\s*\([^;]*?\bnew\s+([A-Za-z_$][\w$]*)\s*\(/gs)) record(m[1], m[2]);
  // Restrict annotation evidence to parameters and variable declarations.
  // Object/interface properties are not receiver bindings and a file-global
  // `source: Source` match could otherwise type an unrelated local `source`.
  for (const m of text.matchAll(/(?:\b(?:const|let|var)\s+|[,(]\s*)([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)\b/g)) {
    record(m[1], m[2]);
  }
  return result;
}

function cppReceiverTypes(source) {
  const result = new Map();
  const ambiguous = new Set();
  const record = (name, type) => {
    if (!type || ambiguous.has(name)) return;
    if (result.has(name) && result.get(name) !== type) {
      result.delete(name);
      ambiguous.add(name);
      return;
    }
    result.set(name, type);
  };
  const text = String(source || '');
  const simpleType = (raw) => String(raw || '')
    .replace(/\b(?:const|volatile|class|struct)\b/g, '')
    .replace(/<.*>/g, '')
    .trim()
    .split('::')
    .pop();

  // Ownership helpers preserve the constructed type even though the declared
  // variable type is `auto` or `std::unique_ptr<T>`.
  for (const m of text.matchAll(/\b(?:auto|[\w:]+(?:\s*<[^;=]+>)?)\s+([A-Za-z_]\w*)\s*=\s*(?:std::)?make_(?:unique|shared)\s*<\s*([\w:]+)[^>]*>/g)) {
    record(m[1], simpleType(m[2]));
  }
  for (const m of text.matchAll(/\bauto\s+([A-Za-z_]\w*)\s*=\s*(?:new\s+)?([A-Z][\w:]*)\s*[({]/g)) {
    record(m[1], simpleType(m[2]));
  }

  // Covers locals, fields and parameters: `Widget w`, `Widget* w`, and
  // `const ns::Widget& w`. Requiring an uppercase final type segment avoids
  // treating ordinary expressions and primitive declarations as class types.
  // Do not accept the optional `class`/`struct` elaborated-type prefix here.
  // A regex engine can backtrack through `struct Owner {` and invent the pair
  // `Owne r`. Elaborated declarations move to the AST-based extractor; ordinary
  // C++ declarations do not need the prefix.
  for (const m of text.matchAll(/(?:^|[,(;{}]\s*)\b(?:const\s+|volatile\s+)*((?:[A-Za-z_]\w*::)*[A-Z][\w]*(?:\s*<[^;(){}]+>)?)\s*[*&]*\s*([A-Za-z_]\w*)\b/gm)) {
    record(m[2], simpleType(m[1]));
  }
  return result;
}

function pythonScopedAliases(rootNode, funcBounds = []) {
  const assignments = new Map();
  const visit = (node) => {
    if (node.type === 'assignment') {
      const left = node.childForFieldName?.('left');
      const right = node.childForFieldName?.('right');
      if (left?.type === 'identifier') {
        const scope = findEnclosingFunction(funcBounds, left.startIndex) || '<module>';
        const key = `${scope}|${left.text}`;
        if (!assignments.has(key)) assignments.set(key, []);
        assignments.get(key).push(right?.type === 'identifier' ? right.text : null);
      }
    }
    for (const child of node.namedChildren || []) visit(child);
  };
  visit(rootNode);
  const result = new Map();
  for (const [key, originals] of assignments) {
    if (originals.length === 1 && originals[0]) result.set(key, originals[0]);
  }
  return result;
}

const LANG_CONFIGS = {
  '.js': {
    wasm: '../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm',
    funcQuery: JS_FUNC_QUERY,
    callQuery: `
      (call_expression function: (identifier) @call_target)
      (call_expression function: (member_expression object: (_) @call_object property: (property_identifier) @call_target))
    `,
    // Ein Klassen-Ausdruck ist ein `class`-Knoten, keine class_declaration.
    // `const Store = class extends Base {}` fehlte damit als Klasse KOMPLETT im
    // Graphen — samt Vererbung. Zwei Muster, weil der Name an zwei Stellen
    // stehen kann: an der Klasse selbst oder, bei einer anonymen Klasse, an der
    // Bindung. `!name` trennt beide, sonst entstuenden zwei Klassen aus einer.
    classQuery: `
      (class_declaration name: (identifier) @class_name)
      (class name: (identifier) @class_name)
      (variable_declarator name: (identifier) @class_name value: (class !name))
      (pair key: (property_identifier) @class_name value: (class !name))
      (export_statement value: (class !name) @anonymous_class)
      (export_statement value: (parenthesized_expression (class !name) @anonymous_class))
    `,
    stateQuery: JS_REACT_STATE_QUERY,
    returnQuery: `(return_statement (_) @return_expr)`,
    importQuery: JS_IMPORT_QUERY,
    requireQuery: JS_REQUIRE_QUERY,
    // Die JavaScript-Grammatik parst JSX auch in .js-Dateien vollständig.
    // Create-React-App-Projekte verwenden oft gar keine .jsx-Endung; null an
    // dieser Stelle machte dort jede Komponente, Prop- und RENDER-Kante unsichtbar.
    jsxQuery: JSX_OUTPUT_QUERY,
    jsxComponentQuery: JSX_COMPONENT_QUERY,
    jsxPropQuery: JSX_PROP_QUERY,
    httpQuery: JS_HTTP_QUERY,
    rosTopicQuery: JS_ROS_TOPIC_QUERY,
    rosLang: 'js',
    hookEffectQuery: JS_HOOK_EFFECT_QUERY,
    classInheritanceQuery: JS_CLASS_INHERITANCE_QUERY,
    instantiationQuery: JS_NEW_QUERY,
    aliasQuery: JS_ALIAS_QUERY,
    callbackQuery: JS_CALLBACK_QUERY,
    conditionalCallQuery: JS_CONDITIONAL_CALL_QUERY,
    asyncChainQuery: JS_ASYNC_CHAIN_QUERY,
    namedImportQuery: JS_NAMED_IMPORT_QUERY,
    namedExportQuery: JS_NAMED_EXPORT_QUERY,
    reactWrapperQuery: JS_REACT_WRAPPER_QUERY,
    jsxSpreadQuery: JSX_SPREAD_QUERY,
    useContextQuery: JS_USE_CONTEXT_QUERY,
    controlFlowQuery: JS_CONTROL_FLOW_QUERY,
    statementQuery: JS_STATEMENT_QUERY,
    variableQuery: JS_VARIABLE_QUERY,
    astQuery: JS_AST_QUERY
  },
  '.jsx': {
    wasm: '../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm',
    funcQuery: JS_FUNC_QUERY,
    callQuery: `
      (call_expression function: (identifier) @call_target)
      (call_expression function: (member_expression object: (_) @call_object property: (property_identifier) @call_target))
    `,
    // Siehe '.js': Klassen-Ausdruecke sind eigene Knoten und fehlten sonst ganz.
    classQuery: `
      (class_declaration name: (identifier) @class_name)
      (class name: (identifier) @class_name)
      (variable_declarator name: (identifier) @class_name value: (class !name))
      (pair key: (property_identifier) @class_name value: (class !name))
      (export_statement value: (class !name) @anonymous_class)
      (export_statement value: (parenthesized_expression (class !name) @anonymous_class))
    `,
    stateQuery: JS_REACT_STATE_QUERY,
    returnQuery: `(return_statement (_) @return_expr)`,
    importQuery: JS_IMPORT_QUERY,
    requireQuery: JS_REQUIRE_QUERY,
    jsxQuery: JSX_OUTPUT_QUERY,
    jsxComponentQuery: JSX_COMPONENT_QUERY,
    jsxPropQuery: JSX_PROP_QUERY,
    httpQuery: JS_HTTP_QUERY,
    rosTopicQuery: JS_ROS_TOPIC_QUERY,
    rosLang: 'js',
    hookEffectQuery: JS_HOOK_EFFECT_QUERY,
    classInheritanceQuery: JS_CLASS_INHERITANCE_QUERY,
    instantiationQuery: JS_NEW_QUERY,
    aliasQuery: JS_ALIAS_QUERY,
    callbackQuery: JS_CALLBACK_QUERY,
    conditionalCallQuery: JS_CONDITIONAL_CALL_QUERY,
    asyncChainQuery: JS_ASYNC_CHAIN_QUERY,
    namedImportQuery: JS_NAMED_IMPORT_QUERY,
    namedExportQuery: JS_NAMED_EXPORT_QUERY,
    reactWrapperQuery: JS_REACT_WRAPPER_QUERY,
    jsxSpreadQuery: JSX_SPREAD_QUERY,
    useContextQuery: JS_USE_CONTEXT_QUERY,
    controlFlowQuery: JS_CONTROL_FLOW_QUERY,
    statementQuery: JS_STATEMENT_QUERY,
    variableQuery: JS_VARIABLE_QUERY,
    astQuery: JS_AST_QUERY
  },
  '.ts': {
    wasm: '../node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm',
    funcQuery: TS_FUNC_QUERY,
    callQuery: `
      (call_expression function: (identifier) @call_target)
      (call_expression function: (member_expression object: (_) @call_object property: (property_identifier) @call_target))
    `,
    // `abstract class` und `interface` sind eigene Knotenarten, keine
    // class_declaration mit Modifier. Solange nur class_declaration abgefragt
    // wurde, fehlten beide vollständig: eine abstrakte Basisklasse erschien
    // nicht im Diagramm, ihre Methoden hingen an keiner Klasse, und jedes
    // `implements I` zeigte auf ein leeres <<external>>-Kästchen, obwohl das
    // Interface in derselben Datei stand.
    classQuery: `
      (class_declaration name: (type_identifier) @class_name)
      (abstract_class_declaration name: (type_identifier) @class_name)
      (interface_declaration name: (type_identifier) @class_name)
      (class name: (type_identifier) @class_name)
      (variable_declarator name: (identifier) @class_name value: (class !name))
      (pair key: (property_identifier) @class_name value: (class !name))
      (export_statement value: (class !name) @anonymous_class)
      (export_statement value: (parenthesized_expression (class !name) @anonymous_class))
    `,
    stateQuery: null,
    returnQuery: `(return_statement (_) @return_expr)`,
    importQuery: JS_IMPORT_QUERY,
    requireQuery: JS_REQUIRE_QUERY,
    jsxQuery: null,
    jsxComponentQuery: null,
    jsxPropQuery: null,
    httpQuery: JS_HTTP_QUERY,
    hookEffectQuery: null,
    classInheritanceQuery: TS_CLASS_INHERITANCE_QUERY,
    instantiationQuery: JS_NEW_QUERY,
    aliasQuery: JS_ALIAS_QUERY,
    callbackQuery: JS_CALLBACK_QUERY,
    conditionalCallQuery: JS_CONDITIONAL_CALL_QUERY,
    asyncChainQuery: JS_ASYNC_CHAIN_QUERY,
    namedImportQuery: JS_NAMED_IMPORT_QUERY,
    namedExportQuery: JS_NAMED_EXPORT_QUERY,
    reactWrapperQuery: JS_REACT_WRAPPER_QUERY,
    jsxSpreadQuery: null,
    useContextQuery: JS_USE_CONTEXT_QUERY,
    controlFlowQuery: JS_CONTROL_FLOW_QUERY,
    statementQuery: JS_STATEMENT_QUERY,
    variableQuery: TS_VARIABLE_QUERY,
    typeRefQuery: TS_TYPE_REF_QUERY,
    astQuery: JS_AST_QUERY
  },
  '.tsx': {
    wasm: '../node_modules/tree-sitter-typescript/tree-sitter-tsx.wasm',
    funcQuery: TS_FUNC_QUERY,
    callQuery: `
      (call_expression function: (identifier) @call_target)
      (call_expression function: (member_expression object: (_) @call_object property: (property_identifier) @call_target))
    `,
    // Siehe '.ts': abstrakte Klassen, Interfaces und Klassen-Ausdruecke fehlten
    // sonst vollständig.
    classQuery: `
      (class_declaration name: (type_identifier) @class_name)
      (abstract_class_declaration name: (type_identifier) @class_name)
      (interface_declaration name: (type_identifier) @class_name)
      (class name: (type_identifier) @class_name)
      (variable_declarator name: (identifier) @class_name value: (class !name))
      (pair key: (property_identifier) @class_name value: (class !name))
      (export_statement value: (class !name) @anonymous_class)
      (export_statement value: (parenthesized_expression (class !name) @anonymous_class))
    `,
    stateQuery: JS_REACT_STATE_QUERY,
    returnQuery: `(return_statement (_) @return_expr)`,
    importQuery: JS_IMPORT_QUERY,
    requireQuery: JS_REQUIRE_QUERY,
    jsxQuery: JSX_OUTPUT_QUERY,
    jsxComponentQuery: JSX_COMPONENT_QUERY,
    jsxPropQuery: JSX_PROP_QUERY,
    httpQuery: JS_HTTP_QUERY,
    hookEffectQuery: JS_HOOK_EFFECT_QUERY,
    classInheritanceQuery: TS_CLASS_INHERITANCE_QUERY,
    instantiationQuery: JS_NEW_QUERY,
    aliasQuery: JS_ALIAS_QUERY,
    callbackQuery: JS_CALLBACK_QUERY,
    conditionalCallQuery: JS_CONDITIONAL_CALL_QUERY,
    asyncChainQuery: JS_ASYNC_CHAIN_QUERY,
    namedImportQuery: JS_NAMED_IMPORT_QUERY,
    namedExportQuery: JS_NAMED_EXPORT_QUERY,
    reactWrapperQuery: JS_REACT_WRAPPER_QUERY,
    jsxSpreadQuery: JSX_SPREAD_QUERY,
    useContextQuery: JS_USE_CONTEXT_QUERY,
    controlFlowQuery: JS_CONTROL_FLOW_QUERY,
    statementQuery: JS_STATEMENT_QUERY,
    variableQuery: TS_VARIABLE_QUERY,
    typeRefQuery: TS_TYPE_REF_QUERY,
    astQuery: JS_AST_QUERY
  },
  '.py': {
    wasm: '../node_modules/tree-sitter-python/tree-sitter-python.wasm',
    funcQuery: PY_FUNC_QUERY,
    // The receiver is captured, not discarded. `event_log.log_incident(...)`
    // used to arrive as the bare name `log_incident`, which the resolver could
    // only guess at — and it declined to guess, so plain `import module` +
    // `module.func()` produced NO call edge at all. That single gap accounted
    // for 54 of the 65 missing call edges measured on this project's Python.
    // `object:` is matched as `(_)` because it may be an identifier (a module),
    // an attribute (`self.acc`) or a call (`super()`); extractCalls decides what
    // to do with each.
    callQuery: `
      (call function: (identifier) @call_target)
      (call function: (attribute object: (_) @call_object attribute: (identifier) @call_target))
    `,
    attributeTypeQuery: PY_ATTRIBUTE_TYPE_QUERY,
    classQuery: `(class_definition name: (identifier) @class_name)`,
    stateQuery: null,
    returnQuery: `(return_statement (_) @return_expr)`,
    importQuery: PY_IMPORT_QUERY,
    namedImportQuery: PY_NAMED_IMPORT_QUERY,
    namedExportQuery: PY_NAMED_EXPORT_QUERY,
    requireQuery: null,
    jsxQuery: null,
    jsxComponentQuery: null,
    jsxPropQuery: null,
    httpQuery: PY_HTTP_QUERY,
    rosInterfaceQuery: PY_ROS_INTERFACE_QUERY,
    rosNodeNameQuery: PY_ROS_NODE_NAME_QUERY,
    rosLang: 'py',
    hookEffectQuery: null,
    classInheritanceQuery: PY_CLASS_INHERITANCE_QUERY,
    instantiationQuery: PY_NEW_QUERY,
    aliasQuery: PY_ALIAS_QUERY,
    moduleAliasQuery: PY_MODULE_ALIAS_QUERY,
    callbackQuery: PY_CALLBACK_QUERY,
    conditionalCallQuery: PY_CONDITIONAL_CALL_QUERY,
    asyncChainQuery: PY_ASYNC_CHAIN_QUERY,
    decoratorQuery: PY_DECORATOR_QUERY,
    typeRefQuery: PY_TYPE_REF_QUERY,
    controlFlowQuery: PY_CONTROL_FLOW_QUERY,
    statementQuery: PY_STATEMENT_QUERY,
    variableQuery: PY_VARIABLE_QUERY,
    astQuery: PY_AST_QUERY
  },
  '.cpp': CPP_LANG_CONFIG,
  '.cc':  CPP_LANG_CONFIG,
  '.cxx': CPP_LANG_CONFIG,
  '.hpp': CPP_LANG_CONFIG,
  '.hh':  CPP_LANG_CONFIG,
  '.h':   CPP_LANG_CONFIG,
  '.c':   C_LANG_CONFIG,
  '.go':  GO_LANG_CONFIG,
  '.rs':  RUST_LANG_CONFIG,
  '.java': JAVA_LANG_CONFIG,
  '.rb':  RUBY_LANG_CONFIG,
  '.kt': KOTLIN_LANG_CONFIG,
  '.kts': KOTLIN_LANG_CONFIG,
  '.sh': BASH_LANG_CONFIG,
  '.bash': BASH_LANG_CONFIG,
  '.lua': LUA_LANG_CONFIG,
  '.xml': XML_LANG_CONFIG
};

// .mjs (ESM) and .cjs (CommonJS) are JavaScript — the '.js' config already
// carries BOTH import and require queries, so reuse it. Without these, Node
// backends written in .cjs/.mjs (and CodeVis's own .cjs/.mjs sources) are
// invisible to the graph — which, beyond incomplete analysis, breaks
// spec-overlay binding against any such project. `extensions` at build time is
// Object.keys(LANG_CONFIGS), so these aliases are auto-discovered and parsed.
LANG_CONFIGS['.cjs'] = LANG_CONFIGS['.js'];
LANG_CONFIGS['.mjs'] = LANG_CONFIGS['.js'];
require('./parser/extractor_contract.cjs').validateExtractorConfigs(LANG_CONFIGS);
const EXTRACTOR_REGISTRY = require('./parser/extractor_registry.cjs').createExtractorRegistry(LANG_CONFIGS);
const EXTRACTOR_CAPABILITIES = EXTRACTOR_REGISTRY.capabilities();

// ============================================================
// HELPER FUNCTIONS
// ============================================================

/**
 * Finds the innermost enclosing function for a given source index.
 * Iterates over all function boundaries and returns the name of the
 * smallest function span that contains the given index.
 * @param {Array<{name: string, startIndex: number, endIndex: number}>} funcBounds - Array of function boundary objects.
 * @param {number} index - The source index to locate within function boundaries.
 * @returns {string|null} The name of the enclosing function, or null if none found.
 */
function findEnclosingFunction(funcBounds, index) {
  const bound = findEnclosingFunctionBound(funcBounds, index);
  return bound ? bound.name : null;
}

/**
 * Wie findEnclosingFunction, aber mit dem ganzen Eintrag statt nur dem Namen.
 *
 * Gebraucht, seit die besitzende Klasse zum Schlüssel eines Function-Knotens
 * gehört: der Name allein identifiziert den Aufrufer nicht mehr. In einer
 * Datei mit `interface Runner { run(); }` und drei Implementierungen gibt es
 * vier Knoten namens `run`, und ein MATCH ohne owner traefe alle vier.
 */
function findEnclosingFunctionBound(funcBounds, index) {
  let enclosing = null;
  let smallestSpan = Infinity;
  for (const fb of funcBounds) {
    if (index >= fb.startIndex && index <= fb.endIndex) {
      const span = fb.endIndex - fb.startIndex;
      if (span < smallestSpan) {
        smallestSpan = span;
        enclosing = fb;
      }
    }
  }
  return enclosing;
}

/** Besitzer der Funktion, die diesen Index umschließt; '' für freie Funktionen. */
function findEnclosingFunctionOwner(funcBounds, index) {
  const bound = findEnclosingFunctionBound(funcBounds, index);
  return bound ? (bound.owner || '') : '';
}

function resolveImportPath(importSource, currentFilePath, existingFiles) {
  const cleaned = importSource.replace(/['"]/g, '');

  // Quoted C/C++ includes sind relativ zur einbindenden Datei und dürfen auch
  // ohne führendes `./` projektlokal sein. Der Projektwurzel-Fallback deckt
  // übliche Include-Pfade wie `#include "lib/foo.h"` ab. System-Header kommen
  // hier nie an: C_INCLUDE_QUERY verwirft system_lib_string bereits im AST.
  if (/\.(?:c|cc|cpp|cxx|h|hh|hpp)$/.test(currentFilePath)) {
    const includeCandidates = [
      toGraphPath(path.join(path.dirname(currentFilePath), cleaned)),
      toGraphPath(cleaned),
    ];
    for (const candidate of includeCandidates) {
      if (candidate !== currentFilePath && existingFiles.has(candidate)) {
        return { resolved: candidate, isExternal: false, moduleName: null };
      }
    }
    return { resolved: null, isExternal: true, moduleName: cleaned };
  }

  // Python relative imports — `from . import x`, `from .mod import Y`,
  // `from ..pkg.deep import Z`. The leading dots count PACKAGE levels, they are
  // not a path prefix: `.mod` means "mod inside my own package", which is
  // `<dir>/mod.py`, not `./mod` — and `..pkg` is the parent package's `pkg`,
  // which path.join would read as a sibling directory called "..pkg". Handled
  // before the generic branch below, which would otherwise mangle both.
  if (currentFilePath.endsWith('.py') && cleaned.startsWith('.')) {
    const dots = cleaned.match(/^\.+/)[0].length;
    const rest = cleaned.slice(dots);
    let dir = path.dirname(path.resolve(projectDir, currentFilePath));
    // One dot is the current package; each extra dot climbs one level.
    for (let i = 1; i < dots; i++) dir = path.dirname(dir);
    const dirRel = toGraphPath(path.relative(projectDir, dir));
    const modRel = rest.replace(/\./g, '/');
    const candidates = rest
      ? [path.join(dirRel, modRel + '.py'), path.join(dirRel, modRel, '__init__.py')]
      : [path.join(dirRel, '__init__.py')];
    for (const candidate of candidates) {
      const cand = toGraphPath(candidate);
      if (existingFiles.has(cand) && cand !== currentFilePath) {
        return { resolved: cand, isExternal: false, moduleName: null };
      }
    }
    return { resolved: null, isExternal: true, moduleName: cleaned };
  }

  if (!cleaned.startsWith('.') && !cleaned.startsWith('/')) {
    // For Python files: try to resolve bare module names (e.g. 'scoring',
    // 'services.geocode') as project-local files before treating as external.
    // Python package separator '.' maps to path separator '/'.
    if (currentFilePath.endsWith('.py')) {
      const modRel = cleaned.replace(/\./g, '/');
      let dir = path.resolve(projectDir, path.dirname(currentFilePath));
      // Walk up ~12 directory levels to find the module root
      for (let i = 0; i < 12; i++) {
        const dirRel = toGraphPath(path.relative(projectDir, dir));
        // Candidate 1: flat module file  (e.g. scoring.py)
        const fileCand = toGraphPath(path.join(dirRel, modRel + '.py'));
        if (existingFiles.has(fileCand) && fileCand !== currentFilePath) {
          return { resolved: fileCand, isExternal: false, moduleName: null };
        }
        // Candidate 2: package __init__.py  (e.g. services/geocode/__init__.py)
        const initCand = toGraphPath(path.join(dirRel, modRel, '__init__.py'));
        if (existingFiles.has(initCand) && initCand !== currentFilePath) {
          return { resolved: initCand, isExternal: false, moduleName: null };
        }
        const parent = path.dirname(dir);
        if (parent === dir) break; // reached filesystem root
        dir = parent;
      }
    }
    // Lua's require("pkg.module") uses dots as directory separators and
    // commonly omits both `./` and `.lua` for project-local modules.
    if (currentFilePath.endsWith('.lua')) {
      const modRel = cleaned.replace(/\./g, '/');
      const candidates = [
        toGraphPath(path.join(path.dirname(currentFilePath), modRel + '.lua')),
        toGraphPath(path.join(path.dirname(currentFilePath), modRel, 'init.lua')),
        `${modRel}.lua`,
        `${modRel}/init.lua`,
      ];
      for (const candidate of candidates) {
        if (candidate !== currentFilePath && existingFiles.has(candidate)) {
          return { resolved: candidate, isExternal: false, moduleName: null };
        }
      }
    }
    // A Kotlin import names a package/class rather than a source path. Match a
    // unique source file with the imported declaration's conventional name;
    // ambiguity is deliberately left external instead of guessing.
    if (/\.kts?$/.test(currentFilePath)) {
      const leaf = cleaned.split('.').pop();
      const matches = [...existingFiles].filter((file) =>
        file !== currentFilePath && file.endsWith(`/${leaf}.kt`)
      );
      if (matches.length === 1) {
        return { resolved: matches[0], isExternal: false, moduleName: null };
      }
      const packageName = cleaned.split('.').slice(0, -1).join('.');
      const declaration = new RegExp(`\\b(?:class|interface|object|fun)\\s+${leaf}\\b`);
      const semanticMatches = [...existingFiles].filter((file) => {
        if (file === currentFilePath || !/\.kts?$/.test(file)) return false;
        try {
          const source = fs.readFileSync(path.resolve(projectDir, file), 'utf8');
          const declaredPackage = /^\s*package\s+([A-Za-z0-9_.]+)/m.exec(source)?.[1] || '';
          return declaredPackage === packageName && declaration.test(source);
        } catch { return false; }
      });
      if (semanticMatches.length === 1) {
        return { resolved: semanticMatches[0], isExternal: false, moduleName: null };
      }
    }
    // Not found in project (or non-Python): treat as external
    return { resolved: null, isExternal: true, moduleName: cleaned };
  }

  const currentDir = path.dirname(currentFilePath);
  const extensions = [
    '.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs', '.py',
    '.kt', '.kts', '.sh', '.bash', '.lua', '.xml', ''
  ];

  // ESM/TS sources import with a JS-output extension (e.g. '../lib/graph.js')
  // that maps to a .ts/.tsx source file on disk. Try the raw specifier first,
  // then a variant with any JS-output extension stripped so the loop below can
  // re-attach the real source extension.
  const specifiers = [cleaned];
  const jsOutExt = cleaned.match(/\.(js|jsx|mjs|cjs)$/);
  if (jsOutExt) {
    specifiers.push(cleaned.slice(0, -jsOutExt[0].length));
  }

  for (const spec of specifiers) {
    // toGraphPath: path.join emits backslashes on Windows, but existingFiles
    // (and every stored File.path) uses forward slashes.
    const candidateBase = toGraphPath(path.join(currentDir, spec));

    for (const ext of extensions) {
      const candidate = candidateBase + ext;
      // Never resolve to the importing file itself (e.g. the codevis.config.js
      // shim requiring codevis.config.cjs — extension stripping would map it
      // back onto the shim and create a bogus self-IMPORTS edge).
      if (candidate === currentFilePath) continue;
      if (existingFiles.has(candidate)) {
        return { resolved: candidate, isExternal: false, moduleName: null };
      }
    }

    for (const ext of extensions) {
      const candidate = toGraphPath(path.join(candidateBase, 'index' + ext));
      if (existingFiles.has(candidate)) {
        return { resolved: candidate, isExternal: false, moduleName: null };
      }
    }
  }

  return { resolved: null, isExternal: true, moduleName: cleaned };
}

function safeQuery(lang, queryStr) {
  if (!queryStr) return null;
  try {
    return new Query(lang, queryStr);
  } catch (e) {
    return null;
  }
}

// ============================================================
// UID GENERATION — deterministic hex IDs for every node
// ============================================================

function makeUid(label, name, file) {
  const raw = `${label}::${name}::${file || ''}`;
  return createHash('sha256').update(raw).digest('hex').substring(0, 16);
}

// Parses "({ prop1, prop2 = default, ...rest })" → ['prop1', 'prop2']
function parseDestructuredProps(paramsText) {
  const match = paramsText.match(/^\(\s*\{([^}]+)\}/);
  if (!match) return null;
  return match[1].split(',')
    .map(s => s.trim().split(/\s*[=:]\s*/)[0].trim().replace(/^\.\.\./, ''))
    .filter(s => /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(s));
}

function isValidReturnExpr(text) {
  if (!text || text.length === 0) return false;
  if (/^[\d.]+$/.test(text)) return false;
  if (text.startsWith('<') || text.startsWith('(')) return false;
  if (text.length > 60) return false;
  if (text.includes('=>')) return false;
  if (text.startsWith('`')) return false;
  return true;
}

function isValidHttpUrl(url) {
  if (!url) return false;
  if (url.length <= 1) return false;
  if (!url.match(/^\/[a-zA-Z]/)) return false;
  return true;
}

// ============================================================
// IPv6 ADDRESS GENERATION — stable, hierarchical code addressing
//
// Schema: fd00:PPPP:FFFF:DDDD:MMMM:SSSS:EEEE:LLLL
//   fd00       = ULA prefix (fixed, RFC 4193)
//   PPPP       = project ID (meta=1, target=2)
//   FFFF       = file identity (from File UID hash — stable)
//   DDDD       = declaration identity (from parent function/class UID — stable)
//   MMMM       = member identity (from own UID — stable)
//   SSSS       = statement/block (reserved for future on-demand use)
//   EEEE       = expression (reserved)
//   LLLL       = leaf (reserved)
//
// Key principle: Each segment is derived from the UID hash of the entity
// at that hierarchy level, NOT from its position. This means:
//   - Re-parsing produces identical addresses (stable)
//   - Children inherit parent prefix (hierarchical)
//   - Subnet locking works via XOR + CLZ (O(1))
//
// Like real networking: parent prefix is fixed, children get
// dynamically assigned identities within the parent's subnet.
// ============================================================

const PROJECT_IDS = { meta: 1, target: 2 };

/** Extract first 16 bits (4 hex chars) from a UID string. */
function uidToHex16(uid) {
  if (!uid) return 0;
  // FNV-1a over the WHOLE uid. The old parseInt(uid.slice(0,4), 16) assumed
  // hex uids; since the Ladybug migration uids are strings like
  // 'Function||name=…' — parseInt swallowed the leading 'F' and every single
  // node landed in subnet 0x000f, collapsing the entire IPv6 hierarchy
  // (and with it subnet-based lock traversal, which then locked everything).
  return uidHash32(uid) & 0xFFFF;
}

/** FNV-1a über den ganzen uid, 32 Bit. Grundlage beider Segmente. */
function uidHash32(uid) {
  let h = 0x811c9dc5;
  for (let i = 0; i < uid.length; i++) {
    h ^= uid.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Das zweite Segment eines Knotens ohne Zeilennummer.
 *
 * Hier stand `parseInt(uid.substring(4, 8), 16) || 0` -- genau die Annahme,
 * die uidToHex16 zwanzig Zeilen weiter oben als Ursache eines behobenen
 * Fehlers beschreibt: dass ein uid hexadezimal sei. Seit der Ladybug-Migration
 * sind uids Zeichenketten wie `Module||name=fs`, und die Zeichen 4 bis 8 sind
 * dann `le||`. An echten uid-Formen gemessen kollabierten fünf von sechs auf
 * 0; `Topic||name=…` ergab aus `c||n` die 12 -- ein Teil-Parse, der
 * deterministisch aussieht und nichts bedeutet.
 *
 * Damit teilten sich alle Knoten ohne Zeilennummer ein /64, das nur noch von
 * den 16 Bit des ersten Segments abhing. Das ist die Erklärung für die in
 * CLAUDE.md notierten 9.352 Knoten auf 8.155 ipv6-Werte, und es trifft die
 * subnetzbasierte Lock-Traversierung: wer ein /64 sperrt, sperrt Knoten aus
 * fremden Verzeichnissen mit.
 *
 * Die oberen 16 Bit desselben Hashes kosten nichts und sind vom unteren
 * Segment unabhängig.
 */
function uidToHex16Upper(uid) {
  if (!uid) return 0;
  return (uidHash32(uid) >>> 16) & 0xFFFF;
}

function hex4(n) { return (n & 0xFFFF).toString(16).padStart(4, '0'); }

/**
 * Build an IPv6 address from hierarchy components.
 * Each component is a 16-bit value derived from the UID of the entity at that level.
 */
function makeIpv6(projectId, fileHex, declHex, memberHex, stmtHex, exprHex, leafHex) {
  return [
    'fd00',
    hex4(projectId),
    hex4(fileHex),
    hex4(declHex || 0),
    hex4(memberHex || 0),
    hex4(stmtHex || 0),
    hex4(exprHex || 0),
    hex4(leafHex || 0)
  ].join(':');
}

/**
 * Assigns stable IPv6 addresses to all nodes in the graph.
 *
 * Hierarchy: Project → File → Declaration → Member
 * Each level's segment comes from the UID hash of the entity at that level.
 * Children inherit their parent's prefix, just like subnets in real networking.
 *
 * Nesting is detected via startLine/endLine range overlap in the AST.
 */
async function assignIpv6Addresses(session, projectId) {
  const filesResult = await session.run(
    `MATCH (f:File) RETURN f.path AS path, f.uid AS uid ORDER BY f.path`
  );

  let totalAssigned = 0;

  // Per-node `MATCH … SET` updates cost a full scan each (uid lookups are the
  // only indexed path) — at 30k+ nodes that phase alone ran for many minutes.
  // All address writes are buffered and flushed as UNWIND batches keyed by uid.
  const ipv6Rows = [];        // { uid, ipv6, mask }
  const ipv6NameRows = [];    // { uid, ipv6, mask, name }  (synthetic names)
  const BATCH = 400;
  const flushIpv6 = async (force = false) => {
    while (ipv6Rows.length >= BATCH || (force && ipv6Rows.length > 0)) {
      const rows = ipv6Rows.splice(0, BATCH);
      await session.run(
        `UNWIND $rows AS row
         MATCH (n) WHERE n.uid = row.uid
         SET n.ipv6 = row.ipv6, n.ipv6mask = row.mask`,
        { rows }
      );
    }
    while (ipv6NameRows.length >= BATCH || (force && ipv6NameRows.length > 0)) {
      const rows = ipv6NameRows.splice(0, BATCH);
      await session.run(
        `UNWIND $rows AS row
         MATCH (n) WHERE n.uid = row.uid
         SET n.ipv6 = row.ipv6, n.ipv6mask = row.mask, n.name = row.name`,
        { rows }
      );
    }
  };
  const queueIpv6 = async (uid, ipv6, mask, name) => {
    // ladybug.int() so the struct-list element binds as INT64 like the proven
    // UNWIND batches elsewhere in this file (plain numbers risk type-inference
    // mismatches in list params).
    if (name != null) ipv6NameRows.push({ uid, ipv6, mask: ladybug.int(mask), name });
    else ipv6Rows.push({ uid, ipv6, mask: ladybug.int(mask) });
    totalAssigned++;
    if (ipv6Rows.length >= BATCH || ipv6NameRows.length >= BATCH) await flushIpv6();
  };

  for (const fileRec of filesResult.records) {
    const filePath = fileRec.get('path');
    const fileUid = fileRec.get('uid') || '';
    const fileHex = uidToHex16(fileUid);

    // Diff-mode fast path: addresses derive deterministically from UIDs, so a
    // file whose nodes all have one already cannot produce different results —
    // skip it. Changed files were wiped + re-parsed, so their nodes (and the
    // File node itself) come in with ipv6 NULL and take the full pass.
    const pendingResult = await session.run(
      `MATCH (f:File {path: $path})
       OPTIONAL MATCH (f)-[:CONTAINS]->(n)
       WHERE n.uid IS NOT NULL AND n.ipv6 IS NULL
       RETURN f.ipv6 AS fileIpv6, count(n) AS pending`,
      { path: filePath }
    );
    const fileHasAddr = pendingResult.records[0] && pendingResult.records[0].get('fileIpv6') != null;
    const pendingCount = pendingResult.records[0] ? Number(pendingResult.records[0].get('pending')) : 0;
    if (fileHasAddr && pendingCount === 0) continue;

    // File: fd00:PPPP:FFFF:0000:0000:0000:0000:0000  /48
    const fileIpv6 = makeIpv6(projectId, fileHex);
    await session.run(
      `MATCH (f:File {path: $path}) SET f.ipv6 = $ipv6, f.ipv6mask = 48`,
      { path: filePath, ipv6: fileIpv6 }
    );
    totalAssigned++;

    // Get all contained nodes with line info + UID
    const nodesResult = await session.run(
      `MATCH (f:File {path: $path})-[:CONTAINS]->(n)
       WHERE n.startLine IS NOT NULL AND n.uid IS NOT NULL
       RETURN id(n) AS nid, labels(n) AS labels, n.name AS name, n.uid AS uid,
              n.startLine AS startLine, n.endLine AS endLine
       ORDER BY n.startLine`,
      { path: filePath }
    );

    if (nodesResult.records.length === 0) continue;

    const nodes = nodesResult.records.map(r => ({
      nid: r.get('nid'),
      labels: r.get('labels'),
      name: r.get('name'),
      uid: r.get('uid'),
      startLine: (() => { const val = r.get('startLine'); return val != null && typeof val.toNumber === 'function' ? val.toNumber() : (typeof val?.low === 'number' ? val.low : val); })(),
      endLine: (() => { const val = r.get('endLine'); return val != null && typeof val.toNumber === 'function' ? val.toNumber() : (typeof val?.low === 'number' ? val.low : val); })(),
    }));

    // Detect top-level declarations (not enclosed by any other node)
    const topLevel = [];
    for (const node of nodes) {
      const isNested = nodes.some(other =>
        other.nid !== node.nid &&
        other.startLine <= node.startLine &&
        other.endLine >= node.endLine &&
        (other.endLine - other.startLine) > (node.endLine - node.startLine)
      );
      if (!isNested) topLevel.push(node);
    }

    // Assign each top-level declaration: fd00:PPPP:FFFF:DDDD:0000:...  /64
    // DDDD comes from the declaration's OWN UID — stable across re-parses
    for (const decl of topLevel) {
      const declHex = uidToHex16(decl.uid);
      const declIpv6 = makeIpv6(projectId, fileHex, declHex);
      await queueIpv6(decl.uid, declIpv6, 64);

      // Find members nested inside this declaration
      const members = nodes.filter(n =>
        n.nid !== decl.nid &&
        n.startLine >= decl.startLine &&
        n.endLine <= decl.endLine
      );

      // Assign each member: fd00:PPPP:FFFF:DDDD:MMMM:0000:...  /80
      // MMMM comes from the member's OWN UID — stable across re-parses
      // The DDDD prefix is inherited from the parent declaration
      for (const member of members) {
        const memberHex = uidToHex16(member.uid);
        const memberIpv6 = makeIpv6(projectId, fileHex, declHex, memberHex);
        await queueIpv6(member.uid, memberIpv6, 80);
      }
    }

    // Orphan nodes (not inside any declaration) — get file-level identity
    const assignedNids = new Set();
    for (const tl of topLevel) {
      assignedNids.add(tl.nid);
      nodes.filter(n =>
        n.nid !== tl.nid && n.startLine >= tl.startLine && n.endLine <= tl.endLine
      ).forEach(m => assignedNids.add(m.nid));
    }

    for (const orph of nodes.filter(n => !assignedNids.has(n.nid))) {
      const orphHex = uidToHex16(orph.uid);
      // Orphans sit at declaration level with their own UID
      const orphIpv6 = makeIpv6(projectId, fileHex, orphHex);
      await queueIpv6(orph.uid, orphIpv6, 64);
    }
  }

  // --- Pass 2: Effect nodes linked via HAS_EFFECT from their parent Function ---
  // These are NOT reachable via File-[:CONTAINS] so they need separate handling.
  // They get /80 addresses nested under their parent Function's /64 subnet.
  // Also assigns synthetic names for Effects with name IS NULL (Task: synthetic-names).
  // Flush first: this query filters on func.ipv6 IS NOT NULL, which must see
  // the addresses pass 1 still has sitting in the buffer.
  await flushIpv6(true);
  const effectsResult = await session.run(
    `MATCH (func:Function)-[:HAS_EFFECT]->(eff:Effect)
     WHERE func.ipv6 IS NOT NULL AND eff.uid IS NOT NULL AND eff.ipv6 IS NULL
     RETURN eff.uid AS uid, eff.name AS name,
            eff.hookType AS hookType, eff.deps AS deps,
            func.ipv6 AS parentIpv6, func.ipv6mask AS parentMask,
            func.name AS parentName, func.uid AS parentUid,
            eff.file AS file`
  );

  // Track synthetic name collisions per (file, parentName) scope
  const syntheticNameCounts = new Map();

  for (const rec of effectsResult.records) {
    const uid = rec.get('uid') || '';
    const parentIpv6Raw = rec.get('parentIpv6') || '';
    const parentMaskRaw = rec.get('parentMask');
    const parentMask = parentMaskRaw != null && typeof parentMaskRaw.toNumber === 'function'
      ? parentMaskRaw.toNumber()
      : (typeof parentMaskRaw?.low === 'number' ? parentMaskRaw.low : parentMaskRaw);
    const parentName = rec.get('parentName') || '';
    const hookType = rec.get('hookType') || 'effect';
    const deps = rec.get('deps') || [];
    const file = rec.get('file') || '';
    const existingName = rec.get('name');

    // Compute /80 IPv6: inherit parent's /64 prefix (first 4 groups), add member hex
    // Parent is either /64 (top-level function) or /80 (nested function)
    // We always nest one level deeper: /64 -> /80, /80 -> /96
    const memberHex = uidToHex16(uid);
    const memberHex4 = hex4(memberHex);
    let effIpv6;
    let effMask;
    if (parentMask <= 64) {
      // parent is a top-level /64 function: strip last 4 groups, add member segment
      const prefix64 = parentIpv6Raw.replace(/:0000:0000:0000:0000$/, '');
      effIpv6 = `${prefix64}:${memberHex4}:0000:0000:0000`;
      effMask = 80;
    } else {
      // parent is already nested (/80): go one level deeper to /96
      const prefix80 = parentIpv6Raw.replace(/:0000:0000:0000$/, '');
      effIpv6 = `${prefix80}:${memberHex4}:0000:0000`;
      effMask = 96;
    }

    // Synthetic name: only set if name IS NULL
    // Format: {hookType}_{uid[0..3]} e.g. effect_8f2b, with collision suffix _2, _3 etc.
    let syntheticName = null;
    if (existingName === null || existingName === undefined) {
      const baseShort = uid.substring(0, 4);
      const baseName = `${hookType}_${baseShort}`;
      const scopeKey = `${file}::${parentName}::${baseName}`;
      const count = (syntheticNameCounts.get(scopeKey) || 0) + 1;
      syntheticNameCounts.set(scopeKey, count);
      syntheticName = count === 1 ? baseName : `${baseName}_${count}`;
    }

    await queueIpv6(uid, effIpv6, effMask, syntheticName);
  }

  // Log synthetic name stats
  if (syntheticNameCounts.size > 0) {
    const total = [...syntheticNameCounts.values()].reduce((a, b) => a + b, 0);
    const collisions = [...syntheticNameCounts.values()].filter(v => v > 1).length;
    console.log(`[synthetic-names] Generated ${total} names, ${collisions} collisions resolved`);
  }

  // --- Pass 3: State nodes linked via File-[:CONTAINS] without startLine ---
  // States have no startLine so they skip the per-file loop above.
  // Find their parent Function via WRITES_STATE edge (the function that sets this state).
  // If no WRITES_STATE parent found, fall back to READS_STATE, then file-level /64.
  // Flush first: the parent lookup filters on func.ipv6 IS NOT NULL.
  await flushIpv6(true);
  const statesResult = await session.run(
    `MATCH (f:File)-[:CONTAINS]->(st:State)
     WHERE st.uid IS NOT NULL AND st.ipv6 IS NULL
     OPTIONAL MATCH (func:Function)-[:WRITES_STATE]->(st)
     WHERE func.ipv6 IS NOT NULL
     WITH st, f, collect(func)[0] AS parentFunc
     OPTIONAL MATCH (func2:Function)-[:READS_STATE]->(st)
     WHERE func2.ipv6 IS NOT NULL AND parentFunc IS NULL
     WITH st, f, parentFunc, collect(func2)[0] AS readFunc
     WITH st, f, coalesce(parentFunc, readFunc) AS resolvedParent
     RETURN st.uid AS uid, st.name AS name,
            f.uid AS fileUid,
            resolvedParent.ipv6 AS parentIpv6,
            resolvedParent.ipv6mask AS parentMask`
  );

  for (const rec of statesResult.records) {
    const uid = rec.get('uid') || '';
    const fileUid = rec.get('fileUid') || '';
    const parentIpv6Raw = rec.get('parentIpv6');
    const parentMaskRaw = rec.get('parentMask');
    const parentMask = parentMaskRaw != null && typeof parentMaskRaw.toNumber === 'function'
      ? parentMaskRaw.toNumber()
      : (typeof parentMaskRaw?.low === 'number' ? parentMaskRaw.low : parentMaskRaw);

    const memberHex = uidToHex16(uid);
    const memberHex4 = hex4(memberHex);

    let stIpv6, stMask;
    if (parentIpv6Raw) {
      // Nest under parent Function
      if (parentMask <= 64) {
        const prefix64 = parentIpv6Raw.replace(/:0000:0000:0000:0000$/, '');
        stIpv6 = `${prefix64}:${memberHex4}:0000:0000:0000`;
        stMask = 80;
      } else {
        const prefix80 = parentIpv6Raw.replace(/:0000:0000:0000$/, '');
        stIpv6 = `${prefix80}:${memberHex4}:0000:0000`;
        stMask = 96;
      }
    } else {
      // No parent found: file-level /64
      const fileHex = uidToHex16(fileUid);
      stIpv6 = makeIpv6(projectId, fileHex, memberHex);
      stMask = 64;
    }

    await queueIpv6(uid, stIpv6, stMask);
  }

  // Nodes without startLine (Module, Endpoint, Topic, etc.) that still lack IPv6
  // These get a file-like address derived purely from their UID
  // Flush first: this selects ipv6 IS NULL — unflushed rows would be re-queued
  // here and their flat /64 would then OVERWRITE the correct nested address.
  await flushIpv6(true);
  const noLineResult = await session.run(
    `MATCH (n) WHERE n.ipv6 IS NULL AND n.uid IS NOT NULL AND NOT n:File AND NOT n:Counter
     RETURN n.uid AS uid`
  );

  for (const rec of noLineResult.records) {
    const uid = rec.get('uid') || '';
    const seg1 = uidToHex16(uid);
    const seg2 = uidToHex16Upper(uid);
    const ipv6 = makeIpv6(projectId, seg1, seg2);
    await queueIpv6(uid, ipv6, 64);
  }

  await flushIpv6(true);

  if (totalAssigned > 0) {
    console.log(`Assigned IPv6 addresses to ${totalAssigned} node(s).`);
  }
}

// ============================================================
// NODE LIFECYCLE — auto-IDs, timestamps, stale file cleanup
// ============================================================

async function assignMissingNodeIds(session) {
  // Step 1: nodes with uid → use as nodeId
  const r1 = await session.run(`
    MATCH (n) WHERE n.nodeId IS NULL AND n.uid IS NOT NULL AND NOT n:Counter
    SET n.nodeId = n.uid, n.createdAt = COALESCE(n.createdAt, timestamp())
    RETURN count(n) AS total
  `);
  const t1 = r1.records[0].get('total').toNumber();

  // Step 2: nodes without uid → generate deterministic hex
  const r2 = await session.run(`
    MATCH (n) WHERE n.nodeId IS NULL AND n.uid IS NULL AND NOT n:Counter
    RETURN id(n) AS nid, labels(n) AS labels,
           coalesce(n.name, '') AS name, coalesce(n.file, '') AS file,
           coalesce(n.url, '') AS url, coalesce(n.localName, '') AS localName,
           coalesce(n.publicName, '') AS publicName
  `);

  for (const record of r2.records) {
    const nid = record.get('nid');
    const labels = record.get('labels').sort().join(':');
    const name = record.get('name') || record.get('localName') || record.get('publicName') || record.get('url') || '';
    const file = record.get('file');
    const hexId = createHash('sha256').update(`${labels}::${name}::${file}`).digest('hex').substring(0, 16);

    await session.run(
      `MATCH (n) WHERE id(n) = $nid SET n.nodeId = $hexId, n.uid = $hexId, n.createdAt = COALESCE(n.createdAt, timestamp())`,
      { nid, hexId }
    );
  }

  const total = t1 + r2.records.length;
  if (total > 0) console.log(`Assigned hex nodeIds to ${total} new node(s).`);

  await session.run(`MATCH (c:Counter) DETACH DELETE c`);
}

/**
 * Write each node's edge count into `n.degree`.
 *
 * Runs LAST, after every extractor, after the deferred edges and after the
 * global call resolution — a degree computed halfway through a build counts
 * only the edges that happened to exist at that moment, and would be wrong for
 * exactly the nodes whose edges arrive late (cross-file calls).
 *
 * Zero is the value that earns this its keep. A node with no edge at all is
 * unreachable for anything that walks the graph — the dashboard's node budget
 * included — so without a stored number those nodes are invisible by
 * construction, and they are the ones worth looking at: dead code, endpoints
 * nothing routes to, a class nobody instantiates.
 *
 * Two statements rather than one: the aggregate only produces rows for nodes
 * that HAVE an edge, so a node whose last caller was just deleted would keep
 * yesterday's number forever. Everything is zeroed first, then the ones with
 * edges are overwritten.
 */
async function stampNodeDegrees(session) {
  try {
    await session.run(`MATCH (n) SET n.degree = 0`);
    const result = await session.run(
      `MATCH (n)-[r]-() WITH n, count(r) AS deg SET n.degree = deg RETURN count(n) AS total`
    );
    const total = result.records[0]?.get('total');
    const connected = typeof total?.toNumber === 'function' ? total.toNumber() : Number(total || 0);
    console.log(`Stamped node degrees: ${connected} node(s) with at least one edge.`);
  } catch (err) {
    // An older database has no `degree` column and reconcileSchema could not
    // reach it (daemon too old, or the DB was opened by something else). The
    // build itself is unaffected — say so and carry on rather than failing a
    // full parse over a display property.
    console.warn(`Could not stamp node degrees: ${err.message}`);
  }
}

// ── Lock & AFFECTS backup/restore helpers ──────────────────────────
// Used by full-mode, diff-mode, and removeDeletedFileNodes to preserve
// lock state and Task edges across node deletion.

async function backupLocksAndAffects(session, filterCypher = '', filterParams = {}) {
  // filterCypher: optional WHERE clause fragment to scope backup, e.g. "AND n.file = $path"
  const lockResult = await session.run(
    `MATCH (n) WHERE n.locked = true ${filterCypher}
     RETURN n.name AS name, n.file AS file, n.path AS path, labels(n) AS labels,
            elementId(n) AS uid, n.owner AS owner, n.bodySnippet AS bodySnippet, n.params AS params,
            n.locked AS locked, n.lockedBy AS lockedBy, n.lockGroup AS lockGroup,
            n.lockExpires AS lockExpires, n.lockOrigin AS lockOrigin,
            n.editInProgress AS editInProgress, n.editInProgressSince AS editInProgressSince`,
    filterParams
  );
  const locks = lockResult.records.map(r => ({
    name: r.get('name'), file: r.get('file'), path: r.get('path'), nodeLabels: r.get('labels'),
    uid: r.get('uid'), owner: r.get('owner'), bodySnippet: r.get('bodySnippet'), params: r.get('params'),
    locked: r.get('locked'), lockedBy: r.get('lockedBy'), lockGroup: r.get('lockGroup'),
    lockExpires: r.get('lockExpires'), lockOrigin: r.get('lockOrigin'),
    editInProgress: r.get('editInProgress'),
    editInProgressSince: r.get('editInProgressSince'),
  }));

  const affectsResult = await session.run(
    `MATCH (t:Task)-[:AFFECTS]->(n) ${filterCypher ? 'WHERE true ' + filterCypher : ''}
     RETURN t.taskId AS taskId, n.name AS name, n.file AS file, n.path AS path, labels(n) AS labels,
            elementId(n) AS uid, n.owner AS owner, n.bodySnippet AS bodySnippet, n.params AS params`,
    filterParams
  );
  const affects = affectsResult.records.map(r => ({
    taskId: r.get('taskId'), name: r.get('name'), file: r.get('file'), path: r.get('path'),
    nodeLabels: r.get('labels'), uid: r.get('uid'), owner: r.get('owner'),
    bodySnippet: r.get('bodySnippet'), params: r.get('params'),
  }));

  const touchedResult = await session.run(
    `MATCH (t:Task)-[r:TOUCHED]->(n) ${filterCypher ? 'WHERE true ' + filterCypher : ''}
     RETURN t.taskId AS taskId, n.name AS name, n.file AS file, n.path AS path, labels(n) AS labels,
            elementId(n) AS uid, n.owner AS owner,
            n.bodySnippet AS bodySnippet, n.params AS params, r.at AS at, r.kind AS kind`,
    filterParams
  );
  const touched = touchedResult.records.map(r => ({
    taskId: r.get('taskId'), name: r.get('name'), file: r.get('file'), path: r.get('path'),
    nodeLabels: r.get('labels'), uid: r.get('uid'), owner: r.get('owner'),
    bodySnippet: r.get('bodySnippet'), params: r.get('params'),
    at: r.get('at'), kind: r.get('kind'),
  }));

  // ── Knowledge APPLIES_TO edges that point at CODE nodes ──
  // Knowledge nodes survive the full-rebuild wipe (see WHERE clause in main),
  // but the code nodes they link to (Function/Class/Component/File) are
  // deleted + recreated, severing the APPLIES_TO edge. These are re-created by
  // name (like Task AFFECTS), so back them up and restore them symmetrically.
  // APPLIES_TO edges to Tasks are skipped here: Tasks also survive the wipe, so
  // those edges stay intact.
  const knowledgeResult = await session.run(
    `MATCH (k:Knowledge)-[:APPLIES_TO]->(n)
     WHERE NOT n:Task ${filterCypher ? 'AND ' + filterCypher.replace(/^\s*AND\s+/i, '') : ''}
     RETURN k.name AS knowledgeName, elementId(k) AS knowledgeUid,
            n.name AS name, n.file AS file, n.path AS path, labels(n) AS labels,
            elementId(n) AS uid, n.owner AS owner, n.bodySnippet AS bodySnippet, n.params AS params`,
    filterParams
  );
  const knowledge = knowledgeResult.records.map(r => ({
    knowledgeName: r.get('knowledgeName'), knowledgeUid: r.get('knowledgeUid'), name: r.get('name'),
    file: r.get('file'), path: r.get('path'), nodeLabels: r.get('labels'),
    uid: r.get('uid'), owner: r.get('owner'), bodySnippet: r.get('bodySnippet'), params: r.get('params'),
  }));

  if (locks.length > 0) console.log(`  Backed up ${locks.length} lock(s).`);
  if (affects.length > 0) console.log(`  Backed up ${affects.length} AFFECTS edge(s).`);
  if (touched.length > 0) console.log(`  Backed up ${touched.length} TOUCHED edge(s).`);
  if (knowledge.length > 0) console.log(`  Backed up ${knowledge.length} Knowledge APPLIES_TO edge(s).`);
  const annotationResult = await session.run(
    `MATCH (a:Annotation)-[:ANNOTATES]->(n) ${filterCypher ? 'WHERE true ' + filterCypher : ''}
     RETURN a.annotationId AS annotationId, elementId(n) AS uid,
            n.name AS name, n.file AS file, n.path AS path, n.owner AS owner,
            labels(n) AS labels, n.bodySnippet AS bodySnippet, n.params AS params`,
    filterParams
  );
  const annotations = annotationResult.records.map(r => ({
    annotationId: r.get('annotationId'), uid: r.get('uid'), name: r.get('name'),
    file: r.get('file'), path: r.get('path'), owner: r.get('owner'),
    nodeLabels: r.get('labels'), bodySnippet: r.get('bodySnippet'), params: r.get('params'),
  }));
  return { locks, affects, touched, knowledge, annotations };
}

// File nodes use path, while their derived nodes use file. Every incremental
// backup must cover exactly the same target set that cleanup will delete.
async function backupFileLinks(session, paths) {
  return backupLocksAndAffects(session, 'AND (n.file IN $paths OR (n:File AND n.path IN $paths))', { paths });
}

/**
 * Resolve a rebuilt target exactly first, then recognize a conservative
 * Function rename by its name-independent body snippet + parameters. The
 * fallback is accepted only when it identifies exactly one candidate (preferring
 * the original file), so similar empty/getter functions are never guessed.
 */
async function resolveRebuiltTargetUid(session, entry) {
  const labels = (entry.nodeLabels || []).filter(l => !['_internal'].includes(l));
  const labelFilter = labels.map(l => `n:${l}`).join(' OR ');
  const whereLabels = labelFilter ? `AND (${labelFilter})` : '';
  const isFile = labels.includes('File');
  if (entry.uid) {
    const byId = await session.run(
      `MATCH (n) WHERE elementId(n) = $uid ${whereLabels}
       RETURN elementId(n) AS uid, n.name AS name, n.file AS file, n.path AS path`,
      { uid: entry.uid }
    );
    if (byId.records.length === 1) return {
      uid: byId.records[0].get('uid'), name: byId.records[0].get('name'),
      file: byId.records[0].get('file'), path: byId.records[0].get('path'), renamed: false,
    };
  }
  const exact = await session.run(
    isFile
      ? `MATCH (n {path: $path}) WHERE true ${whereLabels} RETURN elementId(n) AS uid, n.name AS name, n.file AS file, n.path AS path`
      : `MATCH (n {name: $name, file: $file}) WHERE coalesce(n.owner, '') = $owner ${whereLabels} RETURN elementId(n) AS uid, n.name AS name, n.file AS file, n.path AS path`,
    { name: entry.name, file: entry.file, path: entry.path, owner: entry.owner || '' }
  );
  if (exact.records.length === 1) return {
    uid: exact.records[0].get('uid'), name: exact.records[0].get('name'),
    file: exact.records[0].get('file'), path: exact.records[0].get('path'), renamed: false,
  };

  if (!labels.includes('Function') || !entry.bodySnippet) return null;
  const fingerprint = await session.run(
    `MATCH (n:Function)
     WHERE n.bodySnippet = $bodySnippet AND n.params = $params
     RETURN elementId(n) AS uid, n.name AS name, n.file AS file`,
    { bodySnippet: entry.bodySnippet, params: entry.params }
  );
  const candidates = fingerprint.records.map(r => ({
    uid: r.get('uid'), name: r.get('name'), file: r.get('file'),
  }));
  const sameFile = candidates.filter(c => c.file === entry.file);
  const chosen = sameFile.length === 1 ? sameFile[0] : candidates.length === 1 ? candidates[0] : null;
  if (!chosen) return null;
  console.log(`  Rename detected: '${entry.name}' (${entry.file}) -> '${chosen.name}' (${chosen.file}).`);
  return { ...chosen, path: null, renamed: true };
}

/** Preserve the exact resolved identity for every restored relationship. */
function restoreTargetMatch(target) {
  // Resolution has already selected exactly one node. Keep that identity all
  // the way into the write, including when two classes share a method name.
  return { pattern: '(n)', where: 'elementId(n) = $targetUid', params: { targetUid: target.uid } };
}

async function restoreLocksAndAffects(session, backup) {
  const { locks, affects, touched = [], knowledge = [], annotations = [] } = backup;
  let lockRestored = 0, lockFailed = 0;

  for (const lock of locks) {
    const target = await resolveRebuiltTargetUid(session, lock);
    if (!target) { lockFailed++; console.log(`  WARNING: Could not restore lock for '${lock.name}' in '${lock.file}' — node not found after rebuild.`); continue; }

    const m = restoreTargetMatch(target);
    const res = await session.run(
      `MATCH ${m.pattern} WHERE ${m.where}
       SET n.locked = $locked, n.lockedBy = $lockedBy, n.lockGroup = $lockGroup,
           n.lockExpires = $lockExpires, n.lockOrigin = $lockOrigin,
           n.editInProgress = $editInProgress, n.editInProgressSince = $editInProgressSince
       RETURN count(n) AS c`,
      { ...m.params, locked: lock.locked,
        lockedBy: lock.lockedBy, lockGroup: lock.lockGroup,
        lockExpires: lock.lockExpires, lockOrigin: lock.lockOrigin,
        editInProgress: lock.editInProgress, editInProgressSince: lock.editInProgressSince }
    );
    const rawCount = res.records[0]?.get('c');
    const c = rawCount?.toNumber?.() ?? Number(rawCount || 0);
    if (c > 0) { lockRestored += c; }
    else { lockFailed++; console.log(`  WARNING: Could not restore lock for '${lock.name}' in '${lock.file}' — node not found after rebuild.`); }
  }

  let edgesRestored = 0;
  for (const edge of affects) {
    const target = await resolveRebuiltTargetUid(session, edge);
    if (!target) continue;

    const m = restoreTargetMatch(target);
    const res = await session.run(
      `MATCH (t:Task {taskId: $taskId}), ${m.pattern}
       WHERE ${m.where}
       MERGE (t)-[:AFFECTS]->(n)
       RETURN count(n) AS c`,
      { taskId: edge.taskId, ...m.params }
    );
    const rawCount = res.records[0]?.get('c');
    edgesRestored += rawCount?.toNumber?.() ?? Number(rawCount || 0);
  }

  let touchedRestored = 0, touchedFailed = 0;
  for (const edge of touched) {
    const target = await resolveRebuiltTargetUid(session, edge);
    if (!target) { touchedFailed++; continue; }

    // Historical identity is name+file, matching makeUid. A manual rename
    // followed by a full build can orphan history; rename_function avoids that
    // by mutating the existing node in place.
    const m = restoreTargetMatch(target);
    const res = await session.run(
      `MATCH (t:Task {taskId: $taskId}), ${m.pattern}
       WHERE ${m.where}
       MERGE (t)-[r:TOUCHED]->(n)
       SET r.at = $at, r.kind = $kind
       RETURN count(n) AS c`,
      { taskId: edge.taskId, ...m.params, at: edge.at, kind: edge.kind }
    );
    const rawCount = res.records[0]?.get('c');
    const c = rawCount?.toNumber?.() ?? Number(rawCount || 0);
    if (c > 0) touchedRestored += c;
    else { touchedFailed++; console.log(`  WARNING: Could not restore TOUCHED from task '${edge.taskId}' to '${edge.name}' in '${edge.file}' — target node not found after rebuild.`); }
  }

  let knowledgeRestored = 0, knowledgeFailed = 0;
  for (const edge of knowledge) {
    const target = await resolveRebuiltTargetUid(session, edge);
    if (!target) { knowledgeFailed++; continue; }
    const m = restoreTargetMatch(target);
    const res = await session.run(
      `MATCH (k:Knowledge), ${m.pattern}
       WHERE elementId(k) = $knowledgeUid AND ${m.where}
       MERGE (k)-[:APPLIES_TO]->(n)
       RETURN count(n) AS c`,
      { knowledgeUid: edge.knowledgeUid, ...m.params }
    );
    const rawCount = res.records[0]?.get('c');
    const c = rawCount?.toNumber?.() ?? Number(rawCount || 0);
    if (c > 0) { knowledgeRestored += c; }
    else { knowledgeFailed++; console.log(`  WARNING: Could not restore APPLIES_TO from '${edge.knowledgeName}' to '${edge.name || edge.path}' — target node not found after rebuild.`); }
  }

  let annotationsRestored = 0;
  for (const entry of annotations) {
    const target = await resolveRebuiltTargetUid(session, entry);
    if (!target) {
      console.warn(`  WARNING: Annotation '${entry.annotationId}' has an unresolved target after rebuild: ${entry.name || entry.path}.`);
      continue;
    }
    const result = await session.run(
      `MATCH (a:Annotation {annotationId: $annotationId}), (n)
       WHERE elementId(n) = $targetUid
       SET a.targetUid = $targetUid
       MERGE (a)-[:ANNOTATES]->(n)
       RETURN count(a) AS c`,
      { annotationId: entry.annotationId, targetUid: target.uid }
    );
    const count = result.records[0]?.get('c');
    annotationsRestored += count?.toNumber?.() ?? Number(count || 0);
  }

  if (locks.length > 0) console.log(`  Restored ${lockRestored} lock(s)${lockFailed > 0 ? `, ${lockFailed} failed` : ''}.`);
  if (affects.length > 0) console.log(`  Restored ${edgesRestored} of ${affects.length} AFFECTS edge(s).`);
  if (touched.length > 0) console.log(`  Restored ${touchedRestored} of ${touched.length} TOUCHED edge(s)${touchedFailed > 0 ? `, ${touchedFailed} failed` : ''}.`);
  if (knowledge.length > 0) console.log(`  Restored ${knowledgeRestored} of ${knowledge.length} Knowledge APPLIES_TO edge(s)${knowledgeFailed > 0 ? `, ${knowledgeFailed} failed` : ''}.`);
  return { lockRestored, lockFailed, edgesRestored, touchedRestored, touchedFailed, knowledgeRestored, annotationsRestored };
}

async function getDirectDependentFiles(session, changedPaths, availableFilesByPath) {
  if (changedPaths.length === 0) return [];

  // Cross-file edges are emitted while parsing their source file. Capture the
  // source paths before deleting any changed target nodes, because DETACH
  // DELETE removes the only evidence that those source files need rebuilding.
  const result = await session.run(
    `MATCH (source)-[r]->(target)
     WHERE target.path IN $changedPaths OR target.file IN $changedPaths
     RETURN DISTINCT coalesce(source.file, source.path) AS sourcePath`,
    { changedPaths }
  );
  const changed = new Set(changedPaths);
  const dependentPaths = new Set(
    result.records
      .map(record => record.get('sourcePath'))
      .filter(sourcePath => sourcePath && !changed.has(sourcePath) && availableFilesByPath.has(sourcePath))
  );
  return [...dependentPaths].sort().map(sourcePath => availableFilesByPath.get(sourcePath));
}

async function getDeletedFilePaths(session, allRelativePaths) {
  const result = await session.run(`MATCH (f:File) RETURN f.path AS path`);
  return result.records.map(r => r.get('path')).filter(p => p && !allRelativePaths.has(p));
}

/**
 * Remove every source-derived node owned by one file.
 *
 * Detail extractors use several ownership relations besides CONTAINS, including
 * DECLARES, CONTAINS_AST, CONTAINS_FLOW, CONTAINS_STMT, HAS_EFFECT,
 * IMPORTS_SYMBOL, EXPORTS_SYMBOL and BELONGS_TO. Matching their shared `file`
 * property keeps incremental cleanup independent of that vocabulary and also
 * covers future file-scoped derived labels automatically.
 *
 * Authored/imported labels use the same allow-list as a full rebuild. Keeping
 * one source of truth prevents an authored node that happens to carry a `file`
 * property from being swept up with generated code nodes.
 */
async function removeFileDerivedNodes(session, relativePaths) {
  const filePaths = Array.isArray(relativePaths) ? relativePaths : [relativePaths];
  if (filePaths.length === 0) return;
  const derivedOnly = PRESERVED_LABELS.map(label => `NOT n:${label}`).join(' AND ');
  await session.run(
    `MATCH (n)
     WHERE n.file IN $paths AND ${derivedOnly}
     DETACH DELETE n`,
    { paths: filePaths }
  );
  await session.run(
    `MATCH (f:File) WHERE f.path IN $paths DETACH DELETE f`,
    { paths: filePaths }
  );
}

// Shared semantic nodes deliberately have no `file`: several source files can
// import the same module, call the same endpoint or use the same ROS interface.
// Their lifecycle is therefore defined by their code ownership edges instead.
const SHARED_DERIVED_OWNERSHIP = Object.freeze([
  ['Module', 'IMPORTS'],
  ['Endpoint', 'HANDLES|FETCHES'],
  ['Context', 'CONSUMES_CONTEXT'],
  ['ExternalBase', 'INHERITS'],
  ['Topic', 'USES_TOPIC|PUBLISHES_TOPIC|SUBSCRIBES_TOPIC'],
  ['Service', 'PROVIDES_SERVICE|CALLS_SERVICE'],
  ['Action', 'PROVIDES_ACTION|USES_ACTION'],
]);

async function removeOrphanedSharedDerivedNodes(session) {
  for (const [label, relations] of SHARED_DERIVED_OWNERSHIP) {
    await session.run(
      `MATCH (n:${label})
       WHERE NOT EXISTS { MATCH ()-[:${relations}]->(n) }
       DETACH DELETE n`
    );
  }
}

async function removeDeletedFileNodes(session, allRelativePaths) {
  const toDelete = await getDeletedFilePaths(session, allRelativePaths);
  if (toDelete.length === 0) return [];

  for (const p of toDelete) {
    console.log(`Smart mode: file deleted from disk, removing nodes for: ${p}`);
  }
  const backup = await backupFileLinks(session, toDelete);
  await removeFileDerivedNodes(session, toDelete);
  return backup.locks.length || backup.affects.length || backup.touched.length || backup.knowledge.length || backup.annotations.length
    ? [backup]
    : [];
}

// ============================================================
// EXTRACTION FUNCTIONS
// ============================================================

const FUNCTION_CONTAINER_TYPES = new Set([
  'function_definition',
  'function_declaration',
  'generator_function_declaration',
  'generator_function',
  'method_definition',
  'method_declaration',
  'method',
  'singleton_method',
  'function_item',
  'function_signature',
  'method_signature',
  'abstract_method_signature',
  'lexical_declaration',
  'variable_declaration',
  'field_definition',
  'public_field_definition',
  'pair',
  'assignment_expression',
  'arrow_function',
  'function_expression',
  'export_statement',
]);

/**
 * Was als Klassengrenze zählt, wenn hasFunctionAncestorBeforeClass nach oben
 * läuft. Fehlt eine Knotenart hier, läuft der Aufstieg an der Klasse vorbei
 * bis zum nächsten FUNCTION_CONTAINER_TYPE und verwirft die Methode als
 * verschachtelte Funktion.
 *
 * Genau das passierte mit `export abstract class` und `export interface`:
 * `abstract_class_declaration` und `interface_declaration` standen nicht in
 * dieser Menge, `export_statement` dagegen in FUNCTION_CONTAINER_TYPES. Jede
 * exportierte abstrakte Klasse und jedes exportierte Interface -- in echtem
 * TypeScript nahezu jedes -- kam damit als leerer Kasten ins Diagramm. Ohne
 * `export` funktionierte dieselbe Deklaration, was den Fehler wie ein Problem
 * mit Interfaces aussehen liess statt wie eines mit dem Aufstieg.
 *
 * `class` ist der Klassen-AUSDRUCK (`const A = class { … }`): dort ist der
 * nächste Container `lexical_declaration`, mit demselben Ergebnis.
 */
const CLASS_CONTAINER_TYPES = new Set([
  'class_definition',
  'class_declaration',
  'class_specifier',
  'struct_specifier',
  'abstract_class_declaration',
  'interface_declaration',
  'class',
]);

function resolveFunctionNode(captureNode) {
  let node = captureNode.parent || captureNode;
  while (node && !FUNCTION_CONTAINER_TYPES.has(node.type)) {
    node = node.parent;
  }
  return node || captureNode;
}

function isCustomHookName(name) {
  // React reserviert das Praefix für `use` plus Großbuchstaben. Ein blosses
  // startsWith('use') würde normale Funktionen wie `user()` als Hook labeln.
  return /^use[A-Z0-9_]/.test(name);
}

function jsTsFunctionSemantics(node, name) {
  let cursor = node;
  let isAbstract = false;
  while (cursor) {
    if (['interface_declaration', 'abstract_method_signature', 'method_signature', 'function_signature'].includes(cursor.type)) {
      isAbstract = true;
      break;
    }
    cursor = cursor.parent;
  }
  const prefix = (node?.text || '').slice(0, Math.max(0, (node?.text || '').indexOf(name)));
  const explicit = (/\b(private|protected|public)\b/.exec(prefix) || [])[1];
  return { visibility: explicit || (name.startsWith('#') ? 'private' : 'public'), isAbstract };
}

function countParameters(params) {
  const text = String(params || '').trim().replace(/^\(/, '').replace(/\)$/, '').trim();
  if (!text) return 0;
  let depth = 0;
  let count = 1;
  for (const char of text) {
    if ('([{<'.includes(char)) depth++;
    else if (')]}>' .includes(char)) depth = Math.max(0, depth - 1);
    else if (char === ',' && depth === 0) count++;
  }
  return count;
}

/**
 * A bounds check alone cannot distinguish a method from a local function:
 * both are textually inside the class. Walk the syntax tree towards the class
 * and reject the candidate when another function boundary is encountered
 * first. This covers Python nested defs and JS/TS function declarations,
 * function expressions and arrows inside methods. C++ does not permit nested
 * named functions, but uses the same guard for every function the grammar
 * extracts.
 */
function hasFunctionAncestorBeforeClass(funcNode) {
  let node = funcNode.parent;
  while (node) {
    if (CLASS_CONTAINER_TYPES.has(node.type)) return false;
    if (FUNCTION_CONTAINER_TYPES.has(node.type)) return true;
    node = node.parent;
  }
  return false;
}

async function extractFunctions(session, cached, tree, relativePath, graphMod, classBounds = []) {
  const funcBounds = [];
  if (!cached.funcQuery) return funcBounds;
  const funcMatches = cached.funcQuery.matches(tree.rootNode);
  const seenDefinitions = new Set();

  for (const match of funcMatches) {
    let funcName = null;
    let isAsync = false;
    let returnType = null;
    let isComponent = false;
    let functionNode = null;
    let nameNode = null;
    let params = null;

    // `funcScope` is the class an out-of-line C++ definition belongs to:
    // `void AEB::init() { … }` in a .cpp while `class AEB` lives in the .hpp.
    // Without it those methods were plain free functions in the graph — the
    // class showed zero methods, and anything asking "which class does this
    // belong to" (the ROS diagram, the class diagram) got no answer and
    // invented one from the function name.
    let funcScope = null;
    for (const capture of match.captures) {
      if (capture.name === 'func_name') {
        funcName = capture.node.text;
        nameNode = capture.node;
      }
      if (capture.name === 'func_node') functionNode = capture.node;
      if (capture.name === 'func_scope') funcScope = capture.node.text;
      // Ein ganzer qualifizierter Name (`a::b::c::Cls::m`) statt der
      // ausgeschriebenen Baumform. Der letzte Abschnitt ist die Methode, der
      // vorletzte ihre Klasse -- so kommt jede Verschachtelungstiefe mit einem
      // einzigen Muster aus, statt pro Ebene eines zu brauchen.
      if (capture.name === 'qualified_name') {
        const parts = capture.node.text.split('::').map((s) => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          funcName = parts[parts.length - 1];
          funcScope = parts[parts.length - 2];
          nameNode = capture.node;
        }
      }
      if (capture.name === 'is_async') isAsync = true;
      if (capture.name === 'return_type') returnType = capture.node.text;
      if (capture.name === 'params') params = capture.node.text;
    }

    if (!funcName) continue;

    const funcNode = resolveFunctionNode(nameNode || match.captures[0].node);
    const semanticNode = functionNode || funcNode;

    // Export- und Container-Alternativen können denselben AST-Knoten treffen.
    // MERGE verhindert zwar doppelte DB-Knoten, doppelte funcBounds verfaelschen
    // aber Scope-Auflösung und RENDERS-Zähler. Der Name bleibt Teil des Keys,
    // weil `const a = ..., b = ...` denselben Declaration-Start besitzt.
    const definitionKey = `${funcNode.startIndex}:${funcName}`;
    if (seenDefinitions.has(definitionKey)) continue;
    seenDefinitions.add(definitionKey);

    if (!params && semanticNode && typeof semanticNode.childForFieldName === 'function') {
      const parametersNode = semanticNode.childForFieldName('parameters');
      const parameterNode = semanticNode.childForFieldName('parameter');
      if (parametersNode) params = parametersNode.text;
      // Ohne Klammern muss die Signatur sie selbst ergänzen; sonst entstuende
      // aus `value =>` die unlesbare Signatur `mapvalue`.
      else if (parameterNode) params = `(${parameterNode.text})`;
    }
    // Nicht jede Parameterliste bringt ihre Klammern mit. Pythons
    // `lambda_parameters` sind blosser Text (`self, x`), also ergab
    // `cb = lambda self, x: x` die Signatur `cbself, x` -- Name und erster
    // Parameter zusammengeklebt. Die Prüfung steht bewusst hier und nicht im
    // Zweig oben: sie greift für jede Herkunft, auch für künftige
    // Grammatiken, die ihre Parameter ohne Klammern liefern.
    if (params && !params.trim().startsWith('(')) params = `(${params.trim()})`;
    if (!returnType && semanticNode && typeof semanticNode.childForFieldName === 'function') {
      const returnNode = semanticNode.childForFieldName('return_type');
      if (returnNode) returnType = returnNode.text;
    }
    if (!isAsync && semanticNode && /^\s*async\b/.test(semanticNode.text)) {
      isAsync = true;
    }

    const startLine = funcNode.startPosition.row + 1;
    const endLine = funcNode.endPosition.row + 1;

    // A function nested inside a method (def helper() in __init__) sits inside
    // the class byte range too — byte containment alone would file it as a
    // method. hasFunctionAncestorBeforeClass() walks up the AST: hits another
    // function before the class, so it is local and not a member.
    const enclosingClass = hasFunctionAncestorBeforeClass(funcNode)
      ? null
      : findEnclosingClass(classBounds, funcNode.startIndex);

    // Bei einer ausgelagerten C++-Definition (`void ns::Logger::log() {}` in
    // der .cpp, während `class Logger` in der .hpp steht) gibt es keine
    // umschließende Klasse in DIESER Datei -- der Besitzer steht im
    // Qualifizierer. Ohne ihn fielen `Logger::log`, `FileLogger::log` und
    // `ConsoleLogger::log` in einer Datei wieder auf einen Knoten zusammen,
    // also genau die Kollision, die dieser Schlüssel verhindern soll.
    // Gemessen an einem 37-Dateien-Projekt: 51 von 51 .cpp-Definitionen hatten
    // einen leeren Besitzer.
    //
    // Der Qualifizierer wird auf sein letztes Glied gekürzt, weil der
    // Klassenknoten unter `Logger` steht und nicht unter `ns::Logger` -- so wie
    // extractClassInheritance dieselben Namen kürzt.
    //
    // Die Berechnung steht VOR funcBounds: was dort landet, muss derselbe Wert
    // sein, unter dem der Knoten geschrieben wird, sonst findet ein späterer
    // Auflöser seinen eigenen Aufrufer nicht mehr.
    const scopeOwner = funcScope ? funcScope.split('::').pop().trim() : '';
    const owner = enclosingClass || scopeOwner || '';

    funcBounds.push({
      name: funcName,
      owner,
      scope: funcScope,
      startIndex: funcNode.startIndex,
      endIndex: funcNode.endIndex,
      isComponent: false,
      isHook: isCustomHookName(funcName)
    });

    if (cached.jsxQuery) {
      // Der erste Capture ist bei JS/TS normalerweise nur der Namens-Identifier.
      // Eine JSX-Query auf diesem Blatt kann niemals etwas finden; gesucht wird
      // im vollständigen Definitionsknoten inklusive Arrow-Ausdruck und Body.
      const subMatches = cached.jsxQuery.matches(funcNode);
      if (subMatches.length > 0) isComponent = true;
    }
    funcBounds[funcBounds.length - 1].isComponent = isComponent;

    const asyncPrefix = isAsync ? 'async ' : '';
    const retSuffix = returnType ? `: ${returnType}` : '';
    const signature = `${asyncPrefix}${funcName}${params || '()'}${retSuffix}`;
    const acceptsProps = parseDestructuredProps(params || '()');

    let bodySnippet = null;
    for (let i = 0; i < funcNode.childCount; i++) {
      const child = funcNode.child(i);
      if (child.type === 'statement_block' || child.type === 'block' || child.type === 'compound_statement') {
        bodySnippet = child.text.replace(/\n/g, ' ').replace(/\s+/g, ' ').substring(0, 120);
        break;
      }
    }
    if (!bodySnippet && semanticNode.type === 'arrow_function') {
      const body = semanticNode.childForFieldName('body');
      if (body) {
        bodySnippet = body.text.replace(/\n/g, ' ').replace(/\s+/g, ' ').substring(0, 120);
      }
    }

    const labels = ['Function'];
    const isHook = isCustomHookName(funcName);
    if (isHook) labels.push('Hook');
    if (isAsync) labels.push('Async');
    if (isComponent) labels.push('Component');
    const functionKind = isHook ? 'CustomHook' : null;
    const isKotlin = /\.kts?$/.test(relativePath);
    const isJsTs = /\.[cm]?[jt]sx?$/.test(relativePath);
    const languageSemantics = isKotlin ? kotlinFunctionSemantics(semanticNode.text, funcName)
      : isJsTs ? jsTsFunctionSemantics(semanticNode, funcName) : {};
    const { isOverride = false, isFrameworkEntrypoint = false, entryPointKind = null, visibility = null, isAbstract = false } = languageSemantics;
    const parameterCount = countParameters(params);

    // Die besitzende Klasse gehört zur Identitaet einer Methode.
    //
    // Ohne sie war der Schlüssel {name, file}, und damit fielen in einer
    // gewoehnlichen Datei mehrere verschiedene Funktionen auf EINEN Knoten
    // zusammen: ein Java-Interface `Runner.run()` und seine drei
    // Implementierungen wurden ein einziges `run`, eine Basisklasse und ihre
    // Ableitung teilten sich `__init__`. Gemessen an sechs Dateien: fünf
    // Kollisionen, eine davon über vier Klassen.
    //
    // Die Folgen waren nicht nur unvollständig, sondern falsch. Der zuletzt
    // geschriebene Knoten gewann seine Eigenschaften, also zeigte `Base` die
    // Signatur von `Runner`. Und weil beide Klassen denselben Knoten
    // enthielten, hing dessen INSTANTIATES-Kante an beiden: das Diagramm
    // zeichnete `Base ..> Location : creates` für ein `new` in `Runner`.
    //
    // Freie Funktionen tragen den leeren String, nicht null: MERGE vergleicht
    // null nie als gleich, jeder Aufruf legte sonst einen neuen Knoten an.
    // `owner` ist oben berechnet, zusammen mit dem Eintrag in funcBounds.
    const uid = makeUid('Function', owner ? `${owner}.${funcName}` : funcName, relativePath);

    if (enclosingClass) {
      await session.run(`
        MATCH (f:File {path: $path})
        MATCH (cls:Class {name: $className, file: $path})
        MERGE (func:${labels.join(':')} {name: $funcName, file: $path, owner: $owner})
        SET func.return_type = $returnType,
            func.params = $params,
            func.startLine = $startLine,
            func.endLine = $endLine,
            func.signature = $signature,
            func.bodySnippet = $bodySnippet,
            func.uid = $uid,
            func.acceptsProps = $acceptsProps,
            func.kind = $functionKind
            , func.isOverride = $isOverride
            , func.isFrameworkEntrypoint = $isFrameworkEntrypoint
            , func.entryPointKind = $entryPointKind
            , func.visibility = $visibility
            , func.isAbstract = $isAbstract
            , func.parameterCount = $parameterCount
        MERGE (cls)-[:CONTAINS]->(func)
        MERGE (f)-[:CONTAINS]->(func)
      `, {
        path: relativePath, className: enclosingClass, funcName, owner, returnType,
        params: params || '()', startLine: graphMod.int(startLine),
        endLine: graphMod.int(endLine), signature, bodySnippet, uid, acceptsProps,
        functionKind, isOverride, isFrameworkEntrypoint, entryPointKind, visibility,
        isAbstract, parameterCount: graphMod.int(parameterCount)
      });
    } else {
      await session.run(`
        MATCH (f:File {path: $path})
        MERGE (func:${labels.join(':')} {name: $funcName, file: $path, owner: $owner})
        SET func.return_type = $returnType,
            func.params = $params,
            func.startLine = $startLine,
            func.endLine = $endLine,
            func.signature = $signature,
            func.bodySnippet = $bodySnippet,
            func.uid = $uid,
            func.acceptsProps = $acceptsProps,
            func.kind = $functionKind
            , func.isOverride = $isOverride
            , func.isFrameworkEntrypoint = $isFrameworkEntrypoint
            , func.entryPointKind = $entryPointKind
            , func.visibility = $visibility
            , func.isAbstract = $isAbstract
            , func.parameterCount = $parameterCount
        MERGE (f)-[:CONTAINS]->(func)
      `, {
        path: relativePath, funcName, owner, returnType,
        params: params || '()', startLine: graphMod.int(startLine),
        endLine: graphMod.int(endLine), signature, bodySnippet, uid, acceptsProps,
        functionKind, isOverride, isFrameworkEntrypoint, entryPointKind, visibility,
        isAbstract, parameterCount: graphMod.int(parameterCount)
      });

      // Out-of-line C++ definitions are linked in pass 2, after every class and
      // import is known. Matching the scope globally here linked `A::method`
      // to every class named A in unrelated packages.
    }
  }

  return funcBounds;
}

// A default export has no identifier. Use the file stem, unless that would
// merge it with a real declaration/binding in the same file.
function anonymousDefaultClassName(tree, relativePath) {
  const stem = path.basename(relativePath, path.extname(relativePath));
  const named = tree.rootNode.descendantsOfType([
    'class_declaration', 'abstract_class_declaration', 'class',
    'variable_declarator', 'pair', 'interface_declaration',
  ]).some((node) => (node.childForFieldName('name') || node.childForFieldName('key'))?.text === stem);
  return named ? `${stem}:default` : stem;
}

async function extractClasses(session, cached, tree, relativePath, graphMod) {
  if (!cached.classQuery) return [];

  const classBounds = [];
  const seen = new Set();
  const classMatches = cached.classQuery.matches(tree.rootNode);
  for (const match of classMatches) {
    for (const capture of match.captures) {
      if (capture.name === 'class_name' || capture.name === 'anonymous_class') {
        const className = capture.name === 'anonymous_class'
          ? anonymousDefaultClassName(tree, relativePath) : capture.node.text;
        const classNode = match.captures.find((c) => c.name === 'class_node')?.node
          || (capture.name === 'anonymous_class' ? capture.node : capture.node.parent || capture.node);
        // Multiple direct typedef aliases describe one body, not several types.
        if (seen.has(classNode.startIndex)) continue;
        seen.add(classNode.startIndex);

        let isReactComponent = false;
        const classSource = classNode.text || '';
        if (/extends\s+(React\.)?(Component|PureComponent)\b/.test(classSource)) {
          isReactComponent = true;
        }

        classBounds.push({
          name: className,
          startIndex: classNode.startIndex,
          endIndex: classNode.endIndex
        });

        const labels = isReactComponent ? 'Class:Component' : 'Class';
        const uid = makeUid('Class', className, relativePath);
        await session.run(`
          MATCH (f:File {path: $path})
          MERGE (cls:${labels} {name: $className, file: $path})
          SET cls.startLine = $startLine, cls.endLine = $endLine, cls.uid = $uid,
              cls.kind = $kind
          MERGE (f)-[:CONTAINS]->(cls)
        `, {
          uid, path: relativePath, className,
          kind: classNode.type === 'enum_specifier' ? 'enumeration' : null,
          startLine: graphMod.int(classNode.startPosition.row + 1),
          endLine: graphMod.int(classNode.endPosition.row + 1)
        });
      }
    }
  }
  return classBounds;
}

async function extractStates(session, cached, tree, relativePath, funcBounds) {
  if (!cached.stateQuery) return;

  const states = [];
  const stateMatches = cached.stateQuery.matches(tree.rootNode);

  for (const match of stateMatches) {
    let stateName = null;
    let setterName = null;
    for (const capture of match.captures) {
      if (capture.name === 'state_name') stateName = capture.node.text;
      if (capture.name === 'state_setter') setterName = capture.node.text;
    }
    if (!stateName) continue;
    states.push({ stateName, setterName });
    const uid = makeUid('State', stateName, relativePath);
    await session.run(`
      MATCH (f:File {path: $path})
      MERGE (state:State {name: $stateName, file: $path})
      SET state.uid = $uid
      MERGE (f)-[:CONTAINS]->(state)
    `, { path: relativePath, stateName, uid });
  }

  if (states.length > 0) {
    const sourceText = tree.rootNode.text;
    for (const { stateName: valueName, setterName } of states) {

      for (const fb of funcBounds) {
        const bodyText = sourceText.substring(fb.startIndex, fb.endIndex);

        if (valueName && bodyText.includes(valueName)) {
          await session.run(`
            MATCH (func:Function {name: $funcName, file: $path, owner: $funcOwner})
            MATCH (state:State {name: $stateName, file: $path})
            MERGE (func)-[:READS_STATE]->(state)
          `, { funcName: fb.name, funcOwner: fb.owner || '', path: relativePath, stateName: valueName });
        }

        if (setterName && bodyText.includes(setterName)) {
          await session.run(`
            MATCH (func:Function {name: $funcName, file: $path, owner: $funcOwner})
            MATCH (state:State {name: $stateName, file: $path})
            MERGE (func)-[:WRITES_STATE]->(state)
          `, { funcName: fb.name, funcOwner: fb.owner || '', path: relativePath, stateName: valueName });
        }
      }
    }
  }
}

/**
 * Candidate functions a file can reference: its own functions plus those in
 * directly imported files. ONE moderately expensive query per file — the
 * extractors then resolve names in JS instead of re-running the same
 * EXISTS-subquery scan for every single call site / await / branch call.
 * Returns Map<name, file[]> (same-file entries listed first).
 */
const candidateCache = { path: null, value: null };

async function loadFunctionCandidates(session, relativePath) {
  // 1-entry memo: the extractors run back-to-back on the SAME file inside
  // parseFiles, so without this the identical (expensive) candidate query
  // runs up to five times per file. parseFiles invalidates the cache when a
  // new file's inserts begin (function nodes change between files anyway).
  if (candidateCache.path === relativePath) return candidateCache.value;
  const result = await session.run(`
    MATCH (f:Function)
    WHERE f.file = $path OR EXISTS { MATCH (:File {path: $path})-[:IMPORTS]->(:File {path: f.file}) }
    RETURN f.name AS name, f.file AS file
    ORDER BY CASE WHEN f.file = $path THEN 0 ELSE 1 END
  `, { path: relativePath });
  const byName = new Map();
  for (const rec of result.records) {
    const name = rec.get('name');
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(rec.get('file'));
  }
  candidateCache.path = relativePath;
  candidateCache.value = byName;
  return byName;
}

function invalidateFunctionCandidates() {
  candidateCache.path = null;
  candidateCache.value = null;
  localBindingCache.path = null;
  localBindingCache.value = null;
}

const localBindingCache = { path: null, value: null };

/**
 * `funcName|varName` for every local or parameter binding in this file.
 *
 * Callback detection resolves an argument by NAME against the functions in
 * scope, which cannot by itself tell a passed function from a variable that
 * merely shares its name. Real case: `ttc_s = aeb_evaluator.ttc_s(slot, v)`
 * followed by `log_incident(..., ttc_s=ttc_s, ...)` — the argument is a float,
 * but the name also belongs to an imported function, so it looked like a
 * callback registration.
 *
 * The fix is a scope check, not a type check: inside that function the name is
 * shadowed by a local, so it cannot be referring to the imported function no
 * matter what type it holds. Variables are written before callbacks in pass 2,
 * so the bindings are already in the graph when this runs.
 */
async function loadLocalBindings(session, relativePath) {
  if (localBindingCache.path === relativePath) return localBindingCache.value;
  const result = await session.run(`
    MATCH (fn:Function {file: $path})-[:DECLARES]->(v:Variable {file: $path})
    WHERE v.scope = 'local' OR v.scope = 'param'
    RETURN fn.name AS fn, v.name AS name
  `, { path: relativePath });
  const bindings = new Set(
    result.records.map((r) => `${r.get('fn')}|${r.get('name')}`)
  );
  localBindingCache.path = relativePath;
  localBindingCache.value = bindings;
  return bindings;
}

function selectUnambiguousCallbackTarget(targetFiles, relativePath) {
  if (!targetFiles?.length) return null;
  const local = targetFiles.filter((file) => file === relativePath);
  if (local.length === 1) return local[0];
  const unique = [...new Set(targetFiles)];
  return unique.length === 1 ? unique[0] : null;
}

function simplePythonTypeName(text) {
  if (!text) return null;
  const unquoted = text.replace(/^(['"])(.*)\1$/, '$2');
  if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(unquoted)) return null;
  return unquoted.split('.').pop();
}

async function extractPythonAttributeTypes(
  session, cached, tree, relativePath, funcBounds, classBounds
) {
  const resolved = new Map();
  if (!cached.attributeTypeQuery) return resolved;

  const declarations = new Map();
  for (const match of cached.attributeTypeQuery.matches(tree.rootNode)) {
    const captures = Object.fromEntries(
      match.captures.map((capture) => [capture.name, capture.node])
    );
    if (captures.attr_owner?.text !== 'self' || !captures.attr_name) continue;
    const position = captures.attr_name.startIndex;
    if (findEnclosingFunction(funcBounds, position) !== '__init__') continue;
    const ownerClass = findEnclosingClass(classBounds, position);
    if (!ownerClass) continue;

    const className = simplePythonTypeName(
      captures.attr_class?.text || captures.attr_type?.text
    );
    if (!className) continue;
    const key = `${ownerClass}\0${captures.attr_name.text}`;
    if (!declarations.has(key)) declarations.set(key, new Set());
    declarations.get(key).add(className);
  }

  for (const [key, classNames] of declarations) {
    const targets = new Map();
    for (const className of classNames) {
      const result = await resolveClassCandidate(
        session, relativePath, className, `Python attribute type for ${key.replace('\0', '.')}`
      );
      if (result.status === 'resolved') {
        targets.set(result.candidate.uid, result.candidate);
      }
    }
    if (targets.size === 1) {
      resolved.set(key, targets.values().next().value);
    } else if (targets.size > 1) {
      console.warn(
        `Skipping Python attribute type in '${relativePath}': ` +
        `'${key.replace('\0', '.')}' has conflicting constructor types.`
      );
    }
  }
  return resolved;
}

async function extractCalls(session, cached, tree, relativePath, funcBounds, classBounds = []) {
  if (!cached.callQuery) return;
  const callMatches = cached.callQuery.matches(tree.rootNode);
  if (callMatches.length === 0) return;

  // Resolve call targets in JS against per-file candidate data instead of one
  // EXISTS-subquery scan per call site (a big file has 1000+ call sites).
  // Semantics preserved: a callee resolves to a same-file function first, else
  // to a function in a directly imported file — gated on IMPORTS_SYMBOL, which
  // excludes method-call false positives (e.g. `session.run()` matching an
  // unrelated function named `run`) while staying robust to parse order (the
  // ImportedSymbol node exists for every named import regardless of whether
  // its target file has been parsed yet). The candidate map is shared (and
  // memoized) across all extractors — same-file entries come first, so the
  // first non-same-file entry mirrors the old deterministic LIMIT 1.
  const candidates = await loadFunctionCandidates(session, relativePath);
  const kotlinPackageFuncs = new Map();
  if (/\.kts?$/.test(relativePath)) {
    const packageDir = path.posix.dirname(toGraphPath(relativePath));
    const packageResult = await session.run(
      `MATCH (f:Function) RETURN f.name AS name, f.file AS file`
    );
    const byName = new Map();
    for (const rec of packageResult.records) {
      const file = rec.get('file');
      if (!file || path.posix.dirname(toGraphPath(file)) !== packageDir) continue;
      const name = rec.get('name');
      if (!byName.has(name)) byName.set(name, new Set());
      byName.get(name).add(file);
    }
    for (const [name, files] of byName) {
      if (files.size !== 1) continue;
      const file = files.values().next().value;
      kotlinPackageFuncs.set(name, file);
      if (!candidates.has(name)) candidates.set(name, []);
      if (!candidates.get(name).includes(file)) candidates.get(name).push(file);
    }
  }

  // JS/TS concrete receiver resolution: `const source = new FileFrameSource();
  // source.load()` carries enough evidence to address the class method without
  // guessing from the method name globally. Interface-only receivers remain
  // unresolved until an explicit dispatch model exists.
  const jsReceiverType = new Map();
  const jsMethodFile = new Map();
  if (/\.(?:js|jsx|ts|tsx|mjs|cjs)$/.test(relativePath)) {
    for (const [receiver, type] of jsTsReceiverTypes(tree.rootNode.text)) jsReceiverType.set(receiver, type);
    if (jsReceiverType.size) {
      const methodResult = await session.run(`
        MATCH (c:Class)-[:CONTAINS]->(fn:Function)
        RETURN c.name AS className, c.file AS file, fn.name AS method
      `);
      for (const rec of methodResult.records) {
        const className = rec.get('className');
        if (![...jsReceiverType.values()].includes(className)) continue;
        jsMethodFile.set(`${className}\0${rec.get('method')}`, rec.get('file'));
      }
    }
  }

  // C++ receiver resolution from source-declared types. This deliberately
  // stops at evidence available without a compiler: constructed/typed objects
  // and class-qualified static calls resolve; `auto` returned by an arbitrary
  // factory and virtual dispatch remain for the optional Clang phase.
  const cppReceiverType = /\.(?:cc|cpp|cxx|h|hh|hpp)$/.test(relativePath)
    ? cppReceiverTypes(tree.rootNode.text)
    : new Map();
  const cppMethodFile = new Map();
  if (/\.(?:cc|cpp|cxx|h|hh|hpp)$/.test(relativePath)) {
    const wantedTypes = new Set(cppReceiverType.values());
    for (const match of callMatches) {
      const receiverCapture = match.captures.find((c) => c.name === 'call_object');
      const receiverText = receiverCapture?.node?.text || '';
      if (/^[A-Z][\w:]*(?:<.*>)?$/.test(receiverText)) {
        wantedTypes.add(receiverText.replace(/<.*>/, '').split('::').pop());
      }
    }
    const methodResult = await session.run(`
      MATCH (c:Class)-[:CONTAINS]->(fn:Function)
      RETURN c.name AS className, fn.file AS file, fn.name AS method
    `);
    const possible = new Map();
    for (const rec of methodResult.records) {
      const className = rec.get('className');
      if (!wantedTypes.has(className)) continue;
      const key = `${className}\0${rec.get('method')}`;
      if (!possible.has(key)) possible.set(key, new Set());
      possible.get(key).add(rec.get('file'));
    }
    // A same-named class in two libraries is ambiguous without compiler include
    // paths. Refuse to choose instead of writing a plausible but false edge.
    for (const [key, files] of possible) {
      if (files.size === 1) cppMethodFile.set(key, files.values().next().value);
    }
  }
  const sameFileFuncs = new Set();
  const importedFuncs = new Map(); // name → first matching imported file
  for (const [name, files] of candidates) {
    for (const file of files) {
      if (file === relativePath) sameFileFuncs.add(name);
      else if (!importedFuncs.has(name)) importedFuncs.set(name, file);
    }
  }
  const pythonCallAliases = relativePath.endsWith('.py')
    ? pythonScopedAliases(tree.rootNode, funcBounds)
    : new Map();
  const pythonParamBindings = new Set();
  const callParamBindings = new Set();
  if (cached.variableQuery) {
    for (const match of cached.variableQuery.matches(tree.rootNode)) {
      for (const capture of match.captures) {
        if (capture.name !== 'param_name') continue;
        const scope = findEnclosingFunction(funcBounds, capture.node.startIndex);
        if (scope) {
          callParamBindings.add(`${scope}|${capture.node.text}`);
          if (relativePath.endsWith('.py')) pythonParamBindings.add(`${scope}|${capture.node.text}`);
        }
      }
    }
  }
  const symResult = await session.run(
    `MATCH (:File {path: $path})-[:IMPORTS_SYMBOL]->(s:ImportedSymbol) RETURN s.localName AS n`,
    { path: relativePath }
  );
  const importedSymbols = new Set(symResult.records.map((r) => r.get('n')));

  // Kotlin receiver resolution. Imports normally name a class, while the call
  // target is one of that class's methods (`Helper.process()`). Resolve the
  // receiver to its imported class file, and also follow simple typed/constructed
  // properties (`val helper: Helper`, `val helper = Helper()`). This is scoped
  // evidence; unlike a global method-name match it cannot jump to an unrelated
  // class that happens to expose the same method.
  const kotlinClassFile = new Map();
  const kotlinReceiverType = new Map();
  const kotlinMethodFile = new Map();
  if (/\.kts?$/.test(relativePath)) {
    const importedFileResult = await session.run(
      `MATCH (:File {path: $path})-[:IMPORTS]->(f:File) RETURN f.path AS file`,
      { path: relativePath }
    );
    const allowedFiles = new Set([
      relativePath,
      ...importedFileResult.records.map((r) => r.get('file')).filter(Boolean),
    ]);
    const packageDir = path.posix.dirname(toGraphPath(relativePath));
    const classResult = await session.run(
      `MATCH (c:Class) RETURN c.name AS name, c.file AS file`
    );
    const filesByClass = new Map();
    for (const rec of classResult.records) {
      const name = rec.get('name');
      const file = rec.get('file');
      if (!file || (!allowedFiles.has(file) && path.posix.dirname(toGraphPath(file)) !== packageDir)) continue;
      if (!filesByClass.has(name)) filesByClass.set(name, new Set());
      filesByClass.get(name).add(file);
    }
    for (const [name, files] of filesByClass) {
      if (files.size === 1) kotlinClassFile.set(name, files.values().next().value);
    }
    const methodResult = await session.run(`
      MATCH (c:Class)-[:CONTAINS]->(fn:Function)
      RETURN c.name AS className, c.file AS file, fn.name AS method
    `);
    for (const rec of methodResult.records) {
      const className = rec.get('className');
      const file = rec.get('file');
      if (kotlinClassFile.get(className) !== file) continue;
      kotlinMethodFile.set(`${className}\0${rec.get('method')}`, file);
    }
    for (const [receiver, type] of kotlinReceiverTypes(tree.rootNode.text)) kotlinReceiverType.set(receiver, type);
  }

  // For Python: build a map of method names -> file for methods belonging to
  // imported classes. This resolves calls like self.geocode_service.geocode()
  // where the captured call_target is 'geocode' and the class 'GeocodeService'
  // was imported (i.e. it is in importedSymbols). Without this, such cross-file
  // method calls are invisible because only direct symbol imports are checked.
  const importedClassMethods = new Map(); // methodName → file
  if (relativePath.endsWith('.py') && importedSymbols.size > 0) {
    const importedSymbolsList = Array.from(importedSymbols);
    // UNWIND statt `c.name IN $array`: der Ladybug-Treiber im Builder löst
    // IN-Array-Parameter nicht zuverlaessig auf (der uebrige Code nutzt durchweg
    // UNWIND, z.B. die Blast-Radius-Query) — sonst bleibt die Map leer.
    const methodResult = await session.run(
      `UNWIND $importedSymbols AS symName
       MATCH (c:Class {name: symName})-[:CONTAINS]->(m:Function)
       WHERE EXISTS { MATCH (:File {path: $path})-[:IMPORTS]->(:File {path: c.file}) }
       RETURN m.name AS method, m.file AS file`,
      { path: relativePath, importedSymbols: importedSymbolsList }
    );
    for (const rec of methodResult.records) {
      const method = rec.get('method');
      const file = rec.get('file');
      if (method && file && !importedClassMethods.has(method)) {
        importedClassMethods.set(method, file);
      }
    }
  }

  // Receiver name → the file it stands for, for `import module` style calls.
  //
  // The IMPORTS edge to that file already exists; only the link from the
  // receiver TEXT back to it was missing. Built from the import statements in
  // this file (so `import event_log as el` maps `el`) crossed with the files
  // this file actually imports (so a name that merely looks like a module
  // resolves to nothing).
  const moduleFileByLocalName = new Map();
  if (cached.moduleAliasQuery) {
    const importedFileResult = await session.run(
      `MATCH (:File {path: $path})-[:IMPORTS]->(f:File) RETURN f.path AS path`,
      { path: relativePath }
    );
    const fileByBasename = new Map();
    for (const rec of importedFileResult.records) {
      const p = rec.get('path');
      if (!p) continue;
      const base = p.split('/').pop().replace(/\.[^.]+$/, '');
      if (!fileByBasename.has(base)) fileByBasename.set(base, p);
    }
    for (const match of cached.moduleAliasQuery.matches(tree.rootNode)) {
      let modulePath = null;
      let alias = null;
      for (const capture of match.captures) {
        if (capture.name === 'module_path') modulePath = capture.node.text;
        if (capture.name === 'module_alias') alias = capture.node.text;
      }
      if (!modulePath) continue;
      const segments = modulePath.split('.');
      // Without an alias, `import pkg.sub` binds the TOP name `pkg`, but the
      // file that carries the functions is `sub` — such a call reads
      // `pkg.sub.fn()`, whose receiver is an attribute, not an identifier, so
      // it is out of scope here and only the flat form is mapped.
      const localName = alias || segments[0];
      const file = fileByBasename.get(segments[segments.length - 1]);
      if (file) moduleFileByLocalName.set(localName, file);
    }
  }

  // Returns `{ file, via }` — `via` records WHICH rule resolved the call and is
  // stored on the edge as `resolvedBy`. Not decoration: the rules differ sharply
  // in how much they actually know. A module-qualified hit names exactly one
  // file; a bare same-file name match is a guess that happens to be right most
  // of the time. Anything reading the call graph should be able to tell those
  // apart instead of treating every edge as equally certain.
  const resolveCallee = (name, receiver, enclosingFunc) => {
    const scopedAlias = enclosingFunc && pythonCallAliases.get(`${enclosingFunc}|${name}`);
    const moduleAlias = !pythonParamBindings.has(`${enclosingFunc}|${name}`)
      ? pythonCallAliases.get(`<module>|${name}`)
      : null;
    const aliasedName = !receiver && (scopedAlias || moduleAlias);
    if (aliasedName) {
      if (sameFileFuncs.has(aliasedName)) return { file: relativePath, via: 'single-assignment-alias', name: aliasedName };
      if (importedFuncs.has(aliasedName) && importedSymbols.has(aliasedName)) {
        return { file: importedFuncs.get(aliasedName), via: 'single-assignment-alias', name: aliasedName };
      }
    }
    // Checked first, because it is the most specific evidence there is —
    // otherwise `event_log.log()` would be captured by a local function that
    // happens to share the name.
    if (receiver) {
      const jsType = jsReceiverType.get(receiver);
      const jsFile = jsType && jsMethodFile.get(`${jsType}\0${name}`);
      if (jsFile) return { file: jsFile, via: 'constructed-receiver-type' };
      const cppType = cppReceiverType.get(receiver) || (/^[A-Z]/.test(receiver) ? receiver.split('::').pop() : null);
      const cppFile = cppType && cppMethodFile.get(`${cppType}\0${name}`);
      if (cppFile) return { file: cppFile, via: 'cpp-receiver-type' };
      const kotlinType = kotlinReceiverType.get(receiver) || receiver;
      const kotlinFile = kotlinMethodFile.get(`${kotlinType}\0${name}`);
      if (kotlinFile) {
        return { file: kotlinFile, via: kotlinReceiverType.has(receiver) ? 'kotlin-receiver-type' : 'kotlin-imported-class' };
      }
      const moduleFile = moduleFileByLocalName.get(receiver);
      if (moduleFile && (candidates.get(name) || []).includes(moduleFile)) {
        return { file: moduleFile, via: 'module' };
      }
      if (['self', 'this', 'cls'].includes(receiver) && sameFileFuncs.has(name)) {
        if (relativePath.endsWith('.rs')) return null;
        return { file: relativePath, via: 'self-receiver' };
      }
      // An explicit receiver changes the meaning of a call. If its module or
      // declared type is unknown, matching a same-file function merely because
      // it has the same method name invents a high-confidence edge (for example
      // `external.save()` -> an unrelated local `save`). Keep it unresolved.
      return null;
    }
    if (sameFileFuncs.has(name)) return { file: relativePath, via: 'same-file' };
    if (kotlinPackageFuncs.has(name)) {
      return { file: kotlinPackageFuncs.get(name), via: 'kotlin-package' };
    }
    if (importedFuncs.has(name) && importedSymbols.has(name)) {
      return { file: importedFuncs.get(name), via: 'imported-symbol' };
    }
    if (importedClassMethods.has(name)) {
      return { file: importedClassMethods.get(name), via: 'imported-class-method' };
    }
    return null;
  };

  // `self.attr.method()` has an ATTRIBUTE receiver, so none of the rules above
  // can see it: the module map keys on a plain identifier, and a bare name match
  // would just guess. Resolving it needs the declared type of `self.attr`, taken
  // from the constructor assignment.
  //
  // Deliberately Python-only for now. JS/TS/C++ receivers need different
  // assignment and type systems; treating them as if Python's rules applied
  // would create confident-looking but incorrect cross-class CALLS edges.
  const attributeTypes = relativePath.endsWith('.py')
    ? await extractPythonAttributeTypes(
      session, cached, tree, relativePath, funcBounds, classBounds
    )
    : new Map();

  // Whether this language's call query reports the receiver at all — see the
  // self-call handling below.
  const hasReceiverCapture = (cached.callQuery.captureNames || []).includes('call_object');

  // How many call sites this file has, and how many the rules above could point
  // at a function in the graph. Stored on the File node so "how much of the call
  // graph is actually known here" is answerable without re-parsing anything —
  // an unresolved call leaves NO edge behind, so the graph alone cannot reveal
  // what is missing. Counted per SITE, not per edge: many sites merge into one
  // edge, and a ratio over deduplicated edges would flatter the result.
  let callSitesSeen = 0;
  let callSitesResolved = 0;
  let internalCallSites = 0;

  const seenCalls = new Set();
  for (const match of callMatches) {
    // Target and receiver must be read from the SAME match — iterating captures
    // individually would pair a receiver with whatever target came next.
    let targetCapture = null;
    let receiverNode = null;
    for (const capture of match.captures) {
      if (capture.name === 'call_target') targetCapture = capture;
      if (capture.name === 'call_object') receiverNode = capture.node;
    }
    // Only a plain identifier can name a module. `self.acc.foo()` has an
    // attribute receiver and needs the type of `self.acc`, a different problem.
    const receiver = receiverNode && (
      ['identifier', 'simple_identifier'].includes(receiverNode.type) ||
      ['self', 'this'].includes(receiverNode.text)
    ) ? receiverNode.text : null;
    if (!targetCapture) continue;

    const targetFuncName = targetCapture.node.text;
    const enclosingBound = findEnclosingFunctionBound(funcBounds, targetCapture.node.startIndex);
    const enclosingFunc = enclosingBound ? enclosingBound.name : null;
    const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
    callSitesSeen++;

    // One-hop `self.attr.method()`: resolve `attr` to the class established by
    // the constructor, then link straight to THAT class's method. Only an
    // established type resolves it — falling back to method-name matching would
    // recreate the first-match-wins bug this exists to fix.
    const receiverText = receiverNode ? receiverNode.text : null;
    const selfAttr = receiverText
      ? /^self\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(receiverText)
      : null;
    if (selfAttr) {
      const callerClass = findEnclosingClass(classBounds, targetCapture.node.startIndex);
      const targetClass = callerClass
        ? attributeTypes.get(`${callerClass}\0${selfAttr[1]}`)
        : null;
      if (!targetClass || !enclosingFunc) continue;
      internalCallSites++;
      callSitesResolved++;
      const key = `${enclosingFunc}->${targetClass.uid}:${targetFuncName}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      await session.run(`
        MATCH (caller:Function {name: $callerName, file: $path, owner: $callerOwner})
        MATCH (targetClass:Class {uid: $targetClassUid})-[:CONTAINS]->(callee:Function {name: $targetFuncName})
        MERGE (caller)-[r:CALLS]->(callee)
        SET r.resolvedBy = 'self-attribute'
      `, {
        path: relativePath,
        callerName: enclosingFunc, callerOwner: enclosingOwner,
        targetClassUid: targetClass.uid,
        targetFuncName
      });
      continue;
    }
    // `self.a.b.method()` is outside the one-hop attribute model — do not let it
    // fall through to the name-based rules and get a confident wrong answer.
    if (receiverText && receiverText.startsWith('self.')) continue;
    // Complex/chained receivers still prove that this is not a bare call, even
    // when the lightweight resolver cannot name their type. Never erase that
    // evidence and fall back to an unrelated same-file function by name.
    if (receiverNode && !receiver) continue;
    if (!receiverNode && enclosingFunc && callParamBindings.has(`${enclosingFunc}|${targetFuncName}`)) continue;

    // Coverage is about project calls. Third-party/library invocations cannot
    // resolve to a node in this graph and must not depress the denominator.
    const receiverHasProjectMethod = Boolean(
      (receiver && jsMethodFile.get(`${jsReceiverType.get(receiver)}\0${targetFuncName}`)) ||
      (receiver && cppMethodFile.get(`${cppReceiverType.get(receiver) || receiver.split('::').pop()}\0${targetFuncName}`)) ||
      (receiver && kotlinMethodFile.get(`${kotlinReceiverType.get(receiver) || receiver}\0${targetFuncName}`)) ||
      (receiver && moduleFileByLocalName.get(receiver) && candidates.has(targetFuncName)) ||
      importedClassMethods.has(targetFuncName)
    );
    const scopedAliasKey = `${enclosingFunc || '<module>'}|${targetFuncName}`;
    const hasPythonAlias = pythonCallAliases.has(scopedAliasKey) ||
      (!pythonParamBindings.has(`${enclosingFunc}|${targetFuncName}`) && pythonCallAliases.has(`<module>|${targetFuncName}`));
    if (candidates.has(targetFuncName) || hasPythonAlias || receiverHasProjectMethod) internalCallSites++;

    const resolved = resolveCallee(targetFuncName, receiver, enclosingFunc);
    if (!resolved) continue;
    const { file: calleeFile, via } = resolved;
    const calleeName = resolved.name || targetFuncName;
    callSitesResolved++;

    // Recursion is a real call relation, and a graph is the one representation
    // that shows it at a glance — dropping every self-call threw away the answer
    // to "is this recursive?" and left the built-in cycle query
    // (predefined-queries.cjs) able to see MUTUAL recursion only, never direct.
    //
    // But "same name as the enclosing function" is NOT the same as recursion:
    // `super().__init__()` inside `__init__` calls the BASE class and would
    // otherwise produce a self-loop on every subclass constructor — measured, it
    // was 7 of 11 such edges here. So a self-call only counts when the receiver
    // is absent (`helper()`) or is the instance itself (`self.helper()`).
    //
    // Languages whose call query does not capture a receiver cannot make that
    // distinction, so they keep the old conservative behaviour and simply skip
    // self-calls — better no edge than a wrong one.
    const isSelfCall = enclosingFunc === targetFuncName;
    const receiverIsSelf = !receiverNode
      || ['self', 'cls', 'this'].includes(receiverNode.text);
    if (isSelfCall && !(hasReceiverCapture && receiverIsSelf)) continue;

    if (enclosingFunc) {
      const key = `${enclosingFunc}->${calleeName}@${calleeFile}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      // `this.add()` meint die eigene Klasse, nicht jede Klasse der Datei, die
      // zufällig auch ein `add` hat. Ohne diese Schranke bekam `Store.seed`
      // eine Kante auf `MemoryStore.add`, und im Diagramm stand eine
      // uses-Beziehung zwischen zwei Klassen, die einander nicht kennen.
      // Nur für den self-Empfaenger belegbar: bei jedem anderen Ziel ist der
      // Besitzer an dieser Stelle unbekannt, und eine falsche Einschraenkung
      // faende gar nichts mehr.
      const selfReceiver = via === 'self-receiver' && calleeFile === relativePath;
      await session.run(`
        MATCH (caller:Function {name: $callerName, file: $path, owner: $callerOwner})
        MATCH (callee:Function {name: $targetFuncName, file: $calleeFile})
        ${selfReceiver ? 'WHERE callee.owner = $callerOwner' : ''}
        MERGE (caller)-[r:CALLS]->(callee)
        SET r.resolvedBy = $via
      `, { path: relativePath, callerName: enclosingFunc, callerOwner: enclosingOwner, targetFuncName: calleeName, calleeFile, via });
    } else if (!enclosingFunc) {
      const key = `__file__->${calleeName}@${calleeFile}`;
      if (seenCalls.has(key)) continue;
      seenCalls.add(key);
      await session.run(`
        MATCH (f:File {path: $path})
        MATCH (callee:Function {name: $targetFuncName, file: $calleeFile})
        MERGE (f)-[r:CALLS]->(callee)
        SET r.resolvedBy = $via
      `, { path: relativePath, targetFuncName: calleeName, calleeFile, via });
    }
  }

  await session.run(
    `MATCH (f:File {path: $path})
     SET f.callSites = $seen, f.callsResolved = $resolved,
         f.internalCallSites = $internal, f.externalCallSites = $external`,
    { path: relativePath, seen: ladybug.int(callSitesSeen), resolved: ladybug.int(callSitesResolved),
      internal: ladybug.int(internalCallSites), external: ladybug.int(callSitesSeen - internalCallSites) }
  );
}

/**
 * Rückgabe-Ausdrücke als eigene Knoten.
 *
 * Das lief bis zum 16.08.2026 unter dem Label `Variable`, und das war eine
 * Verwechslung von Kategorien: `return max(vals) if vals else None` ist keine
 * Variable, sondern ein Ausdruck. Gemessen an den beiden gebauten Graphen
 * schlug das kräftig durch — 1.150 von 12.213 `Variable`-Knoten in CodeVis
 * (9,4 %) und 602 von 6.985 im Zielprojekt stammten von hier, ohne
 * Zeilennummer, ohne Typ, mit dem auf 60 Zeichen mitten im Token
 * abgeschnittenen Ausdruckstext als Namen. Wer `MATCH (v:Variable)` schrieb,
 * bekam sie ungefragt mitgeliefert.
 *
 * Dazu kam eine zweite Identität: hier wurde auf `{name, file}` gemerged, die
 * echte Deklaration in extractVariables auf `{elementId, file}`. `return count`
 * legte deshalb einen ZWEITEN Knoten namens `count` an, der nichts mit der
 * deklarierten Variablen `count` zu tun hatte — 190 solcher Doppel in CodeVis,
 * 69 im Zielprojekt.
 *
 * Jetzt: eigenes Label `ReturnValue`, dieselbe elementId-Identität wie überall
 * sonst, und die Zeilennummer wird mitgeschrieben — sie stand die ganze Zeit im
 * Syntaxbaum und wurde nur weggeworfen. Die RETURNS-Kante bleibt, wie sie war;
 * kein Verbraucher setzt voraus, dass ihr Ziel eine Variable ist.
 */
async function extractReturns(session, cached, tree, relativePath, funcBounds) {
  if (!cached.returnQuery) return;

  const seen = new Set();
  const returnMatches = cached.returnQuery.matches(tree.rootNode);
  for (const match of returnMatches) {
    for (const capture of match.captures) {
      if (capture.name === 'return_expr') {
        const returnText = capture.node.text;
        const cleanName = returnText.replace(/\n/g, ' ').replace(/\s+/g, ' ').substring(0, 60);

        if (!isValidReturnExpr(cleanName)) continue;

        const startLine = capture.node.startPosition.row + 1;
        const col = capture.node.startPosition.column;
        // Ort statt Text als Schlüssel: zwei Funktionen, die beide `return null`
        // schreiben, sind zwei Rückgaben und nicht eine.
        const elementId = `return:${startLine}:${col}`;
        const dedupe = `${relativePath}::${elementId}`;
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);

        const uid = makeUid('ReturnValue', elementId, relativePath);

        const enclosingBound = findEnclosingFunctionBound(funcBounds, capture.node.startIndex);
        const enclosingFunc = enclosingBound ? enclosingBound.name : null;
        const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';

        // Knoten und Kante in EINEM Statement, so wie es die alte Fassung
        // hielt. Getrennt waren es zwei Anfragen pro Rückgabe, und weil MERGE
        // ohne Index über die ganze Knotentabelle sucht, bezahlt man den Scan
        // dann zweimal. Bei 256 Dateien summiert sich das spürbar.
        const params = {
          elementId, path: relativePath, cleanName,
          startLine: ladybug.int(startLine), uid,
        };
        if (enclosingFunc) {
          await session.run(`
            MATCH (func:Function {name: $funcName, file: $path, owner: $funcOwner})
            MERGE (rv:ReturnValue {elementId: $elementId, file: $path})
            SET rv.name = $cleanName, rv.startLine = $startLine, rv.uid = $uid
            MERGE (func)-[:RETURNS]->(rv)
          `, { ...params, funcName: enclosingFunc, funcOwner: enclosingOwner });
        } else {
          await session.run(`
            MATCH (f:File {path: $path})
            MERGE (rv:ReturnValue {elementId: $elementId, file: $path})
            SET rv.name = $cleanName, rv.startLine = $startLine, rv.uid = $uid
            MERGE (f)-[:RETURNS]->(rv)
          `, params);
        }
      }
    }
  }
}

async function extractImports(session, cached, tree, relativePath, allRelativePaths) {
  if (cached.importQuery) {
    const importMatches = cached.importQuery.matches(tree.rootNode);
    for (const match of importMatches) {
      for (const capture of match.captures) {
        if (capture.name === 'import_source') {
          const rawSource = capture.node.text;
          await processImportSource(session, rawSource, relativePath, allRelativePaths);
          // Kotlin imports bind the final declaration name in local scope. The
          // generic import pass previously created only File-[:IMPORTS]->File;
          // extractCalls intentionally refuses a cross-file bare-name match
          // without IMPORTS_SYMBOL, so every Kotlin call stayed unresolved.
          if (/\.kts?$/.test(relativePath)) {
            const clean = rawSource.replace(/\s+as\s+.*/, '').trim();
            const alias = /\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(rawSource)?.[1];
            const importedName = clean.split('.').pop();
            const { resolved } = resolveImportPath(clean, relativePath, allRelativePaths);
            if (resolved && importedName && importedName !== '*') {
              const localName = alias || importedName;
              await session.run(`
                MATCH (f:File {path: $fromFile})
                MERGE (sym:ImportedSymbol {localName: $localName, file: $fromFile})
                SET sym.originalName = $importedName, sym.sourceFile = $resolved
                MERGE (f)-[:IMPORTS_SYMBOL]->(sym)
              `, { fromFile: relativePath, localName, importedName, resolved });
            }
          }
        }
      }
    }
  }

  if (cached.requireQuery) {
    const requireMatches = cached.requireQuery.matches(tree.rootNode);
    for (const match of requireMatches) {
      let isRequire = false;
      let importSource = null;

      for (const capture of match.captures) {
        if (capture.name === 'req_func' && capture.node.text === 'require') isRequire = true;
        if (capture.name === 'import_source') importSource = capture.node.text;
      }

      if (isRequire && importSource) {
        await processImportSource(session, importSource, relativePath, allRelativePaths);
      }
    }
  }
}

async function processImportSource(session, rawSource, relativePath, allRelativePaths) {
  const { resolved, isExternal, moduleName } = resolveImportPath(
    rawSource, relativePath, allRelativePaths
  );

  if (!isExternal && resolved) {
    await session.run(`
      MATCH (f:File {path: $from})
      MERGE (target:File {path: $to})
      MERGE (f)-[:IMPORTS]->(target)
    `, { from: relativePath, to: resolved });
  } else if (isExternal && moduleName) {
    const cleanModule = moduleName.replace(/['"]/g, '').split('/')[0];
    await session.run(`
      MATCH (f:File {path: $from})
      MERGE (m:Module {name: $moduleName})
      MERGE (f)-[:IMPORTS]->(m)
    `, { from: relativePath, moduleName: cleanModule });
  }
}

async function linkAndroidManifestComponents(session, parsedFilesInfo) {
  const manifests = parsedFilesInfo.filter((info) =>
    /(?:^|\/)AndroidManifest\.xml$/i.test(info.relativePath)
  );
  for (const manifest of manifests) {
    const names = new Set();
    for (const match of manifest.tree.rootNode.text.matchAll(
      /(?:android:)?name\s*=\s*["']([^"']+)["']/g
    )) {
      const value = match[1];
      if (/^[A-Za-z_.][A-Za-z0-9_.$]*$/.test(value)) names.add(value.split('.').pop());
    }
    for (const className of names) {
      const result = await session.run(
        `MATCH (c:Class {name: $className}) RETURN c.file AS file`,
        { className }
      );
      const files = [...new Set(result.records.map((r) => r.get('file')).filter(Boolean))];
      if (files.length !== 1) continue;
      await session.run(`
        MATCH (manifest:File {path: $manifestPath})
        MATCH (component:Class {name: $className, file: $classFile})
        SET component.isFrameworkEntrypoint = true,
            component.entryPointKind = 'android-manifest-component'
        MERGE (manifest)-[:IMPORTS]->(component)
      `, { manifestPath: manifest.relativePath, className, classFile: files[0] });
      await session.run(`
        MATCH (component:Class {name: $className, file: $classFile})-[:CONTAINS]->(fn:Function)
        WHERE fn.isOverride = true
        SET fn.isFrameworkEntrypoint = true,
            fn.entryPointKind = CASE
              WHEN fn.entryPointKind IS NULL THEN 'android-component-override'
              ELSE fn.entryPointKind END
      `, { className, classFile: files[0] });
    }
  }
}

function extractJsxRenders(cached, tree, relativePath, funcBounds, deferredRenders) {
  if (!cached.jsxComponentQuery) return;

  const jsxMatches = cached.jsxComponentQuery.matches(tree.rootNode);
  for (const match of jsxMatches) {
    for (const capture of match.captures) {
      if (capture.name === 'component_name') {
        const componentName = capture.node.text;
        if (componentName[0] !== componentName[0].toUpperCase()) continue;

        const callIndex = capture.node.startIndex;
        const enclosingBound = findEnclosingFunctionBound(funcBounds, callIndex);
        const enclosingFunc = enclosingBound ? enclosingBound.name : null;
        const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';

        if (enclosingFunc && enclosingFunc !== componentName) {
          deferredRenders.push({ parentName: enclosingFunc, parentFile: relativePath, childName: componentName });
        } else if (!enclosingFunc) {
          let ancestor = capture.node;
          let reactRoot = false;
          while (ancestor && ancestor.type !== 'program') {
            if (ancestor.type === 'call_expression' && /\bcreateRoot\s*\([\s\S]*?\)\.render\s*\(/.test(ancestor.text)) {
              reactRoot = true;
              break;
            }
            ancestor = ancestor.parent;
          }
          if (reactRoot) deferredRenders.push({ parentFile: relativePath, childName: componentName, frameworkRoot: true });
        }
      }
    }
  }
}

function extractJsxProps(cached, tree, relativePath, funcBounds, deferredPropsMap) {
  if (!cached.jsxComponentQuery || !cached.jsxPropQuery) return;

  const jsxElements = cached.jsxComponentQuery.matches(tree.rootNode);
  for (const match of jsxElements) {
    for (const capture of match.captures) {
      if (capture.name === 'component_name') {
        const componentName = capture.node.text;
        if (componentName[0] !== componentName[0].toUpperCase()) continue;

        const jsxNode = capture.node.parent;
        const enclosingBound = findEnclosingFunctionBound(funcBounds, capture.node.startIndex);
        const enclosingFunc = enclosingBound ? enclosingBound.name : null;
        const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
        if (!enclosingFunc || enclosingFunc === componentName) continue;

        const key = `${enclosingFunc}|${relativePath}|${componentName}`;
        if (!deferredPropsMap[key]) {
          deferredPropsMap[key] = {
            parentName: enclosingFunc,
            parentFile: relativePath,
            childName: componentName,
            props: [],
            spreadVars: []
          };
        }

        for (let i = 0; i < jsxNode.childCount; i++) {
          const child = jsxNode.child(i);
          if (child.type === 'jsx_attribute') {
            const propIdent = child.childForFieldName('name') || child.child(0);
            if (propIdent) {
              const propName = propIdent.text;
              if (!deferredPropsMap[key].props.includes(propName)) {
                deferredPropsMap[key].props.push(propName);
              }
            }
          }
        }
      }
    }
  }
}

async function extractHttpEndpoints(session, cached, tree, relativePath, funcBounds) {
  if (!cached.httpQuery) return;

  const httpMatches = cached.httpQuery.matches(tree.rootNode);
  for (const match of httpMatches) {
    let httpUrl = null;
    let httpMethod = null;
    let httpFunc = null;
    let handlerName = null;

    for (const capture of match.captures) {
      if (capture.name === 'http_url') httpUrl = capture.node.text.replace(/['"]/g, '');
      if (capture.name === 'http_method') httpMethod = capture.node.text;
      if (capture.name === 'http_func') httpFunc = capture.node.text;
      if (capture.name === 'handler_name') handlerName = capture.node.text;
    }

    if (!isValidHttpUrl(httpUrl)) continue;

    const method = httpMethod || (httpFunc === 'fetch' ? 'GET' : 'UNKNOWN');
    const enclosingBound = findEnclosingFunctionBound(funcBounds, match.captures[0].node.startIndex);
    const enclosingFunc = enclosingBound ? enclosingBound.name : null;
    const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';

    await session.run(`
      MERGE (ep:Endpoint {url: $url})
      SET ep.method = $method
    `, { url: httpUrl, method: method.toUpperCase() });

    if (handlerName) {
      await session.run(`
        MATCH (ep:Endpoint {url: $url})
        MATCH (handler:Function {name: $handlerName, file: $path})
        SET handler:HTTPHandler
        MERGE (handler)-[:HANDLES]->(ep)
      `, { url: httpUrl, handlerName, path: relativePath });
    } else if (enclosingFunc) {
      await session.run(`
        MATCH (ep:Endpoint {url: $url})
        MATCH (caller:Function {name: $callerName, file: $path, owner: $callerOwner})
        MERGE (caller)-[:FETCHES]->(ep)
      `, { url: httpUrl, callerName: enclosingFunc, callerOwner: enclosingOwner, path: relativePath });
    }
  }
}

// ============================================================
// NEW EXTRACTORS — ported from external App
// ============================================================


// ============================================================
// NEW EXTRACTORS — ported from external App
// ============================================================

/** Enclosing class for a source offset — the ROS analogue of findEnclosingFunction. */
function findEnclosingClass(classBounds, index) {
  let best = null;
  for (const cb of classBounds || []) {
    if (index >= cb.startIndex && index <= cb.endIndex) {
      // Innermost wins for nested classes.
      if (!best || (cb.endIndex - cb.startIndex) < (best.endIndex - best.startIndex)) best = cb;
    }
  }
  return best ? best.name : null;
}

/**
 * Positional arguments of a tree-sitter argument list, as
 * `{ text, isLiteral }` — the shape scripts/ros/ros_model.js expects.
 * Anonymous tokens ( `(` `,` `)` ) are not named children, so they drop out
 * automatically; comments are skipped explicitly.
 */
function positionalArgs(argListNode) {
  const out = [];
  if (!argListNode) return out;
  for (let i = 0; i < argListNode.namedChildCount; i++) {
    const c = argListNode.namedChild(i);
    if (!c || c.type === 'comment') continue;
    out.push({
      text: c.text,
      isLiteral: c.type === 'string' || c.type === 'string_literal' || c.type === 'concatenated_string',
    });
  }
  return out;
}

/** Read `{ key: 'value' }` pairs out of a JS object literal node. */
function objectLiteralProps(objNode) {
  const props = {};
  if (!objNode) return props;
  for (let i = 0; i < objNode.namedChildCount; i++) {
    const pair = objNode.namedChild(i);
    if (!pair || pair.type !== 'pair') continue;
    const key = pair.childForFieldName('key');
    const value = pair.childForFieldName('value');
    if (!key || !value) continue;
    props[key.text.replace(/['"]/g, '')] = {
      text: value.text,
      isLiteral: value.type === 'string',
    };
  }
  return props;
}

/**
 * ROS 2 interface extraction — topics, services and actions, in Python, C++
 * and roslib/JS.
 *
 * The classification (which argument is the name, which is the type, is this a
 * service or an action) lives in scripts/ros/ros_model.js; this function does
 * the tree walking and the graph writes. Interfaces are attached to the
 * enclosing Function when there is one, and additionally to the enclosing
 * Class, because a ROS node *is* the class — the diagram generator reads the
 * class-level edges.
 */
async function extractRosInterfaces(session, cached, tree, relativePath, funcBounds, classBounds) {
  const lang = cached.rosLang;
  if (!lang) return;

  /** Write one interface node + the edge(s) from its owner. */
  const record = async (info, startIndex) => {
    const { label, relType, name, dynamic, msgType, callback } = info;

    await session.run(
      `MERGE (t:${label} {name: $name})
       SET t.rosKind = $kind, t.rosDynamic = $dynamic`,
      { name, kind: info.kind, dynamic }
    );
    if (msgType) {
      // A topic is written from every file that touches it, and the same type
      // is spelled differently per language: C++ gives the fully qualified
      // `geometry_msgs/msg/Twist`, Python usually just the imported `Twist`.
      // Without this guard the winner would be whichever file parsed last. A
      // qualified type always wins; an unqualified one only fills a blank.
      await session.run(`
        MATCH (t:${label} {name: $name})
        WHERE t.msgType IS NULL OR $qualified = true
        SET t.msgType = $msgType
      `, { name, msgType, qualified: msgType.includes('/') });
    }

    const enclosingBound = findEnclosingFunctionBound(funcBounds, startIndex);
    const enclosingFunc = enclosingBound ? enclosingBound.name : null;
    const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
    const enclosingClass = findEnclosingClass(classBounds, startIndex);

    if (enclosingFunc) {
      await session.run(`
        MATCH (t:${label} {name: $name})
        MATCH (f:Function {name: $funcName, file: $path, owner: $funcOwner})
        MERGE (f)-[r:${relType}]->(t)
        SET r.msgType = $msgType, r.callback = $callback
      `, { name, funcName: enclosingFunc, funcOwner: enclosingOwner, path: relativePath, msgType: msgType || null, callback: callback || null });
    }

    if (enclosingClass) {
      await session.run(`
        MATCH (t:${label} {name: $name})
        MATCH (c:Class {name: $className, file: $path})
        MERGE (c)-[r:${relType}]->(t)
        SET r.msgType = $msgType, r.callback = $callback
      `, { name, className: enclosingClass, path: relativePath, msgType: msgType || null, callback: callback || null });
    }

    if (!enclosingFunc && !enclosingClass) {
      await session.run(`
        MATCH (t:${label} {name: $name})
        MATCH (file:File {path: $path})
        MERGE (file)-[r:${relType}]->(t)
        SET r.msgType = $msgType, r.callback = $callback
      `, { name, path: relativePath, msgType: msgType || null, callback: callback || null });
    }
  };

  // --- Python / C++: factory calls ---------------------------------------
  if (cached.rosInterfaceQuery) {
    for (const match of cached.rosInterfaceQuery.matches(tree.rootNode)) {
      let method = null, argsNode = null, typesNode = null, startIndex = 0;
      for (const capture of match.captures) {
        if (capture.name === 'ros_method') { method = capture.node.text; startIndex = capture.node.startIndex; }
        if (capture.name === 'ros_args') argsNode = capture.node;
        if (capture.name === 'ros_types') typesNode = capture.node;
      }
      if (!method) continue;
      const info = rosModel.classifyRosCall({
        method,
        lang,
        args: positionalArgs(argsNode),
        templateType: typesNode ? typesNode.text : null,
      });
      if (info) await record(info, startIndex);
    }
  }

  // --- roslib (JS): `new ROSLIB.Topic({ name, messageType })` -------------
  if (cached.rosTopicQuery) {
    for (const match of cached.rosTopicQuery.matches(tree.rootNode)) {
      let ctor = null, objNode = null, startIndex = 0;
      for (const capture of match.captures) {
        if (capture.name === 'ros_ctor') { ctor = capture.node.text; startIndex = capture.node.startIndex; }
        if (capture.name === 'ros_obj') objNode = capture.node;
      }
      const kind = ROSLIB_CTORS[ctor];
      if (!kind) continue;

      const props = objectLiteralProps(objNode);
      const nameProp = props.name || props.topic || props.service || props.action;
      if (!nameProp) continue;
      const named = rosModel.normalizeRosName(nameProp.text, { wasLiteral: nameProp.isLiteral });
      if (!named) continue;

      const typeProp = props.messageType || props.serviceType || props.actionType;
      const msgType = typeProp && typeProp.isLiteral
        ? rosModel.normalizeMsgType(rosModel.stripQuotes(typeProp.text))
        : null;

      // roslib objects carry no direction at construction time — `.publish()`
      // and `.subscribe()` decide it later. USES_TOPIC is the honest edge here.
      await record({
        kind,
        label: rosModel.KIND_LABEL[kind],
        relType: kind === 'topic' ? 'USES_TOPIC' : rosModel.REL_BY_KIND[kind].consume,
        name: named.name,
        dynamic: named.dynamic,
        msgType,
        callback: null,
      }, startIndex);
    }
  }
}

/** roslib constructor -> interface kind. */
const ROSLIB_CTORS = { Topic: 'topic', Service: 'service', Action: 'action', ActionClient: 'action' };

/**
 * Mark classes that are ROS nodes (`class X(Node)`, `class X : public rclcpp::Node`)
 * and record the runtime node name passed to the base constructor. Without this
 * the diagram generator cannot tell a ROS node apart from any other class.
 */
async function extractRosNodes(session, cached, tree, relativePath, classBounds, opts = {}) {
  if (!cached.rosLang) return;
  const { markOnly = false, namesOnly = false } = opts;

  // --- which classes derive from a ROS node base? ------------------------
  const rosClasses = new Set();
  if (!namesOnly && classBounds && classBounds.length > 0 && cached.classInheritanceQuery) {
    for (const match of cached.classInheritanceQuery.matches(tree.rootNode)) {
      let className = null;
      const bases = [];
      for (const capture of match.captures) {
        if (capture.name === 'class_name') className = capture.node.text;
        if (capture.name === 'base_class') bases.push(capture.node.text);
      }
      if (!className) continue;
      const rosBase = bases.find((b) => rosModel.isRosNodeBase(b));
      if (!rosBase) continue;
      rosClasses.add(className);
      await session.run(`
        MATCH (c:Class {name: $className, file: $path})
        SET c.isRosNode = true, c.rosBase = $rosBase
      `, { className, path: relativePath, rosBase });
    }
  }
  if (markOnly) return;

  // In the normal single-file/test path the classes marked above are the only
  // valid enclosing classes. The production two-phase path uses namesOnly
  // after every file's ROS inheritance has already been marked.
  if (namesOnly && classBounds && classBounds.length > 0 && cached.classInheritanceQuery) {
    for (const match of cached.classInheritanceQuery.matches(tree.rootNode)) {
      let className = null;
      const bases = [];
      for (const capture of match.captures) {
        if (capture.name === 'class_name') className = capture.node.text;
        if (capture.name === 'base_class') bases.push(capture.node.text);
      }
      if (className && bases.some((base) => rosModel.isRosNodeBase(base))) rosClasses.add(className);
    }
  }

  // --- the runtime node name from the base-constructor call --------------
  if (!cached.rosNodeNameQuery) return;
  for (const match of cached.rosNodeNameQuery.matches(tree.rootNode)) {
    let initName = null, superFn = null, nodeName = null, constructorScope = null, startIndex = 0;
    for (const capture of match.captures) {
      if (capture.name === 'init_name') { initName = capture.node.text; startIndex = capture.node.startIndex; }
      if (capture.name === 'super_fn') superFn = capture.node.text;
      if (capture.name === 'node_name') nodeName = capture.node.text;
      if (capture.name === 'constructor_scope') constructorScope = capture.node.text;
    }
    if (!nodeName) continue;
    // Python: only `super().__init__('name')`. C++: only `: Node("name")`.
    const isPyInit = superFn === 'super' && initName === '__init__';
    const isCppInit = rosModel.isRosNodeBase(initName);
    if (!isPyInit && !isCppInit) continue;

    const className = constructorScope || findEnclosingClass(classBounds, startIndex);
    if (!className) continue;

    if (constructorScope) {
      // Pass 2 runs only after every file's Class nodes exist. The constructor
      // body may therefore live in a .cpp while its ROS inheritance lives in a
      // header. Resolve the exact declaration just like out-of-line methods.
      const target = await resolveClassCandidate(
        session, relativePath, className, 'ROS node-name assignment'
      );
      if (target.status !== 'resolved') continue;
      await session.run(`
        MATCH (c:Class {uid: $classUid})
        WHERE c.isRosNode = true
        SET c.rosNodeName = $nodeName
      `, {
        classUid: target.candidate.uid,
        className,
        nodeName: rosModel.stripQuotes(nodeName)
      });
      continue;
    }
    if (!rosClasses.has(className)) continue;

    await session.run(`
      MATCH (c:Class {uid: $classUid})
      SET c.rosNodeName = $nodeName
    `, {
      classUid: makeUid('Class', className, relativePath),
      className,
      nodeName: rosModel.stripQuotes(nodeName)
    });
  }
}

/**
 * `new Foo()` → `(owner)-[:INSTANTIATES]->(:Class {name: 'Foo'})`.
 *
 * Runs in pass 2 because the target class may live in any file, and all Class
 * nodes exist only once pass 1 has been through every file.
 *
 * Two rules keep this honest:
 *
 *  - An edge is written ONLY when a Class of that name is already in the graph.
 *    Source code is full of `new Map()`, `new Error()`, `new Date()`; creating
 *    nodes for those would fill the graph with classes nobody wrote and make
 *    the class diagram a list of standard-library types. A library class simply
 *    produces no edge — a gap is better than an invention.
 *  - The owner is the enclosing Function when there is one, otherwise the File.
 *    Class-level associations are derived from these edges by the diagram
 *    layer (Class -CONTAINS-> Function -INSTANTIATES-> Class), so a single
 *    edge per call site is enough and cannot fall out of sync with itself.
 *
 */
/**
 * Class resolution is deliberately separated from edge writes. All successful
 * matches return the file-based Class UID and every edge then matches that UID,
 * never a graph-global name.
 */
let classCatalogCache = null;
const classContextCache = new Map();

function selectUniqueClassCandidate(candidates, context) {
  if (candidates.length === 1) return { status: 'resolved', candidate: candidates[0], context };
  if (candidates.length > 1) return { status: 'ambiguous', candidates, context };
  return null;
}

function cppSiblingStem(file) {
  return /\.(?:c|cc|cpp|cxx|h|hh|hpp)$/i.test(file)
    ? file.replace(/\.(?:c|cc|cpp|cxx|h|hh|hpp)$/i, '')
    : null;
}

function selectClassCandidate(catalog, classContext, relativePath, localName) {
  const named = [];
  for (const symbol of classContext.symbols) {
    if (symbol.localName !== localName) continue;
    named.push(...catalog.filter((c) =>
      c.file === symbol.sourceFile && c.name === symbol.originalName
    ));
  }
  let selected = selectUniqueClassCandidate(named, 'named import');
  if (selected) return selected;

  selected = selectUniqueClassCandidate(
    catalog.filter((c) => c.file === relativePath && c.name === localName),
    'same file'
  );
  if (selected) return selected;

  selected = selectUniqueClassCandidate(
    catalog.filter((c) => classContext.importedFiles.has(c.file) && c.name === localName),
    'imported file'
  );
  if (selected) return selected;

  const siblingStem = cppSiblingStem(relativePath);
  if (siblingStem) {
    selected = selectUniqueClassCandidate(
      catalog.filter((c) => cppSiblingStem(c.file) === siblingStem && c.name === localName),
      'C++ sibling header/source'
    );
    if (selected) return selected;
  }

  selected = selectUniqueClassCandidate(
    catalog.filter((c) => c.name === localName),
    'globally unique fallback'
  );
  return selected || { status: 'missing', candidates: [], context: 'project' };
}

async function loadClassCatalog(session) {
  if (classCatalogCache) return classCatalogCache;
  const res = await session.run(
    `MATCH (c:Class) RETURN c.uid AS uid, c.name AS name, c.file AS file`
  );
  classCatalogCache = res.records.map((r) => ({
    uid: r.get('uid'),
    name: r.get('name'),
    file: r.get('file'),
  })).filter((c) => c.uid && c.name && c.file);
  return classCatalogCache;
}

async function loadClassContext(session, relativePath) {
  if (classContextCache.has(relativePath)) return classContextCache.get(relativePath);
  // Keep these sequential: Neo4j-compatible sessions do not guarantee that
  // concurrent session.run calls on the same session are safe.
  const imports = await session.run(
    `MATCH (:File {path: $path})-[:IMPORTS]->(f:File) RETURN f.path AS file`,
    { path: relativePath }
  );
  const symbols = await session.run(
    `MATCH (:File {path: $path})-[:IMPORTS_SYMBOL]->(s:ImportedSymbol)
     RETURN s.localName AS localName, s.originalName AS originalName, s.sourceFile AS sourceFile`,
    { path: relativePath }
  );
  const context = {
    importedFiles: new Set(imports.records.map((r) => r.get('file')).filter(Boolean)),
    symbols: symbols.records.map((r) => ({
      localName: r.get('localName'),
      originalName: r.get('originalName'),
      sourceFile: r.get('sourceFile'),
    })),
  };
  classContextCache.set(relativePath, context);
  return context;
}

async function resolveClassCandidate(session, relativePath, localName, relation) {
  const result = selectClassCandidate(
    await loadClassCatalog(session),
    await loadClassContext(session, relativePath),
    relativePath,
    localName
  );
  if (result.status === 'ambiguous') {
    const choices = result.candidates.map((c) => `${c.name}@${c.file}`).join(', ');
    console.warn(
      `Skipping ${relation} in '${relativePath}': class '${localName}' is ambiguous ` +
      `in ${result.context} (${choices}).`
    );
  }
  return result;
}

function invalidateClassResolution() {
  classCatalogCache = null;
  classContextCache.clear();
}

async function linkOutOfLineMethods(session, relativePath, funcBounds) {
  const scoped = new Map();
  for (const fn of funcBounds) {
    if (fn.scope) scoped.set(`${fn.scope}\0${fn.name}`, fn);
  }
  for (const fn of scoped.values()) {
    const target = await resolveClassCandidate(
      session, relativePath, fn.scope, `C++ method ownership for ${fn.scope}::${fn.name}`
    );
    if (target.status !== 'resolved') continue;
    // Über den Besitzer, nicht nur über den Namen: eine .cpp enthält
    // regelmäßig `Logger::log`, `FileLogger::log` und `ConsoleLogger::log`
    // nebeneinander. Ohne owner hätte jede dieser Klassen alle drei Rumpfe
    // als Methode bekommen.
    await session.run(`
      MATCH (cls:Class {uid: $classUid})
      MATCH (func:Function {name: $funcName, file: $path, owner: $funcOwner})
      MERGE (cls)-[:CONTAINS]->(func)
    `, {
      classUid: target.candidate.uid, funcName: fn.name,
      funcOwner: fn.owner || (fn.scope ? String(fn.scope).split('::').pop().trim() : ''),
      path: relativePath,
    });
  }
}

async function extractInstantiations(session, cached, tree, relativePath, funcBounds) {
  if (!cached.instantiationQuery) return;

  // Collect call sites first, then hit the database once per distinct name:
  // a file that constructs the same class forty times should not produce forty
  // lookups.
  const sitesByName = new Map();
  for (const match of cached.instantiationQuery.matches(tree.rootNode)) {
    for (const capture of match.captures) {
      if (capture.name !== 'class_name') continue;
      // `new ns.Widget()` / `pkg.Widget()` — the class is the last segment.
      const raw = capture.node.text;
      const name = raw.split(/::|\./).pop().trim();
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
      if (!sitesByName.has(name)) sitesByName.set(name, []);
      sitesByName.get(name).push(capture.node.startIndex);
    }
  }
  if (sitesByName.size === 0) return;

  for (const [className, positions] of sitesByName) {
    const target = await resolveClassCandidate(
      session, relativePath, className, 'INSTANTIATES'
    );
    if (target.status !== 'resolved') continue;
    const classUid = target.candidate.uid;

    // De-duplicate owners: MERGE is idempotent, but one round trip per call
    // site to the same function is pure waste on a file with a hot loop.
    //
    // Der Name allein identifiziert die umschließende Funktion nicht: eine
    // Basisklasse und ihre Ableitung haben beide `__init__`, und ohne die
    // besitzende Klasse im Schlüssel bekamen BEIDE die INSTANTIATES-Kante --
    // das Diagramm zeichnete dann "Base erzeugt Location" für ein new in
    // Runner. Deshalb wird hier über Name UND Besitzer entschieden.
    const owners = new Map();
    for (const startIndex of positions) {
      const bound = findEnclosingFunctionBound(funcBounds, startIndex);
      if (!bound) { owners.set('\0file', null); continue; }
      owners.set(`${bound.owner || ''}\0${bound.name}`, bound);
    }

    for (const bound of owners.values()) {
      if (bound) {
        await session.run(`
          MATCH (target:Class {uid: $classUid})
          MATCH (f:Function {name: $funcName, file: $path, owner: $funcOwner})
          MERGE (f)-[:INSTANTIATES]->(target)
        `, { classUid, funcName: bound.name, funcOwner: bound.owner || '', path: relativePath });
      } else {
        await session.run(`
          MATCH (target:Class {uid: $classUid})
          MATCH (file:File {path: $path})
          MERGE (file)-[:INSTANTIATES]->(target)
        `, { classUid, path: relativePath });
      }
    }
  }
}

async function extractDOMElements(session, cached, tree, relativePath, funcBounds) {
  if (!cached.jsxComponentQuery) return;

  const EVENT_ATTRS = new Set([
    'onClick', 'onChange', 'onSubmit', 'onInput', 'onFocus', 'onBlur',
    'onMouseDown', 'onMouseUp', 'onMouseEnter', 'onMouseLeave',
    'onKeyDown', 'onKeyUp', 'onKeyPress', 'onScroll', 'onDrag',
    'onDrop', 'onDoubleClick', 'onContextMenu', 'onTouchStart', 'onTouchEnd'
  ]);

  const jsxMatches = cached.jsxComponentQuery.matches(tree.rootNode);

  for (const match of jsxMatches) {
    for (const capture of match.captures) {
      if (capture.name !== 'component_name') continue;

      const tagName = capture.node.text;
      const jsxNode = capture.node.parent;
      if (!jsxNode) continue;

      let testId = null;
      const eventHandlers = [];

      for (let i = 0; i < jsxNode.childCount; i++) {
        const child = jsxNode.child(i);
        if (child.type !== 'jsx_attribute') continue;

        const attrNameNode = child.child(0);
        if (!attrNameNode) continue;
        const attrName = attrNameNode.text;

        const valNode = child.childCount >= 3 ? child.child(child.childCount - 1) : null;

        if (attrName === 'data-testid') {
          if (valNode) {
            testId = valNode.text.replace(/['"{}]/g, '');
          }
        }

        if (EVENT_ATTRS.has(attrName)) {
          let handlerName = null;
          if (valNode) {
            const rawText = valNode.text.replace(/[{}]/g, '').trim();
            const directMatch = rawText.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)$/);
            if (directMatch) {
              handlerName = directMatch[1];
            } else {
              const arrowMatch = rawText.match(/=>\s*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*[\(]/);
              if (arrowMatch) handlerName = arrowMatch[1];
            }
          }
          eventHandlers.push({ event: attrName, handler: handlerName });
        }
      }

      const enclosingBound = findEnclosingFunctionBound(funcBounds, capture.node.startIndex);
      const enclosingFunc = enclosingBound ? enclosingBound.name : null;
      const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
      const elementId = testId || `${tagName}_${capture.node.startPosition.row + 1}`;
      const uid = makeUid('DOMElement', elementId, relativePath);
      const startLine = capture.node.startPosition.row + 1;

      // `name` wird mitgesetzt, weil der Graph Knoten über genau dieses Feld
      // beschriftet. Ohne es waren alle DOMElement-Knoten namenlose Punkte —
      // und weil DOMElement in einem React-Projekt der mit Abstand häufigste
      // Typ ist, war ein guter Teil des Graphen schlicht unlesbar. elementId
      // ist entweder die data-testid oder `tag_zeile`, also in beiden Fällen
      // das, was man sehen will.
      await session.run(`
        MERGE (dom:DOMElement {elementId: $elementId, file: $path})
        SET dom.tagName = $tagName,
            dom.name = $elementId,
            dom.testId = $testId,
            dom.uid = $uid,
            dom.startLine = $startLine,
            dom.eventHandlers = $events
      `, {
        elementId, path: relativePath, tagName,
        testId: testId || null, uid, startLine: ladybug.int(startLine),
        events: eventHandlers.map(e => e.event)
      });

      if (enclosingFunc) {
        await session.run(`
          MATCH (dom:DOMElement {elementId: $elementId, file: $path})
          MATCH (comp:Function {name: $compName, file: $path})
          MERGE (dom)-[:BELONGS_TO]->(comp)
        `, { elementId, path: relativePath, compName: enclosingFunc });
      }

      for (const eh of eventHandlers) {
        if (!eh.handler) continue;
        await session.run(`
          MATCH (dom:DOMElement {elementId: $elementId, file: $path})
          MATCH (handler:Function {name: $handlerName})
          WHERE handler.file = $path
             OR EXISTS { MATCH (:File {path: $path})-[:IMPORTS]->(:File {path: handler.file}) }
          MERGE (dom)-[:ON_EVENT {event: $event}]->(handler)
        `, {
          elementId, path: relativePath,
          handlerName: eh.handler, event: eh.event
        });
      }
    }
  }
}

// ============================================================
// FULL-AST EXTRACTORS — Control Flow, Statements, all Variables
// ============================================================

const CF_CAPTURE_TO_KIND = {
  if_stmt: 'if', for_stmt: 'for', for_in_stmt: 'for_in',
  while_stmt: 'while', do_while_stmt: 'do_while',
  switch_stmt: 'switch', try_stmt: 'try'
};

const STMT_CAPTURE_TO_LABEL = {
  return_stmt: 'ReturnStatement',
  throw_stmt: 'ThrowStatement',
  break_stmt: 'BreakStatement',
  continue_stmt: 'ContinueStatement'
};

async function extractControlFlow(session, cached, tree, relativePath, funcBounds) {
  if (!cached.controlFlowQuery) return;
  const matches = cached.controlFlowQuery.matches(tree.rootNode);

  for (const match of matches) {
    for (const capture of match.captures) {
      const kind = CF_CAPTURE_TO_KIND[capture.name];
      if (!kind) continue;

      const node = capture.node;
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const col = node.startPosition.column;
      const enclosingBound = findEnclosingFunctionBound(funcBounds, node.startIndex);
      const enclosingFunc = enclosingBound ? enclosingBound.name : null;
      const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
      const elementId = `${kind}:${startLine}:${col}`;
      const uid = makeUid('ControlFlow', elementId, relativePath);
      const label = kind === 'if' ? 'IfStatement'
                  : kind === 'switch' ? 'SwitchStatement'
                  : kind === 'try' ? 'TryStatement'
                  : kind.startsWith('for') ? 'ForLoop'
                  : 'WhileLoop';
      const preview = node.text.split('\n')[0].substring(0, 80);
      let depth = 0;
      const controlTypes = new Set(['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_statement', 'try_statement']);
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (controlTypes.has(parent.type)) depth++;
        if (FUNCTION_CONTAINER_TYPES.has(parent.type)) break;
      }

      await session.run(`
        MERGE (cf:ControlFlow {elementId: $elementId, file: $path})
        SET cf:${label},
            cf.kind = $kind,
            cf.startLine = $startLine,
            cf.endLine = $endLine,
            cf.preview = $preview,
            cf.depth = $depth,
            cf.uid = $uid
      `, {
        elementId, path: relativePath, kind,
        startLine: ladybug.int(startLine), endLine: ladybug.int(endLine),
        preview, uid, depth: ladybug.int(depth)
      });

      if (enclosingFunc) {
        await session.run(`
          MATCH (cf:ControlFlow {elementId: $elementId, file: $path})
          MATCH (fn:Function {name: $funcName, file: $path, owner: $funcOwner})
          MERGE (fn)-[:CONTAINS_FLOW]->(cf)
        `, { elementId, path: relativePath, funcName: enclosingFunc, funcOwner: enclosingOwner });
      } else {
        await session.run(`
          MATCH (cf:ControlFlow {elementId: $elementId, file: $path})
          MATCH (f:File {path: $path})
          MERGE (f)-[:CONTAINS_FLOW]->(cf)
        `, { elementId, path: relativePath });
      }
    }
  }
}

async function extractStatements(session, cached, tree, relativePath, funcBounds) {
  if (!cached.statementQuery) return;
  const matches = cached.statementQuery.matches(tree.rootNode);

  for (const match of matches) {
    for (const capture of match.captures) {
      const label = STMT_CAPTURE_TO_LABEL[capture.name];
      if (!label) continue;

      const node = capture.node;
      const startLine = node.startPosition.row + 1;
      const col = node.startPosition.column;
      const enclosingBound = findEnclosingFunctionBound(funcBounds, node.startIndex);
      const enclosingFunc = enclosingBound ? enclosingBound.name : null;
      const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
      const elementId = `${capture.name}:${startLine}:${col}`;
      const uid = makeUid(label, elementId, relativePath);
      const preview = node.text.split('\n')[0].substring(0, 80);

      await session.run(`
        MERGE (s:${label} {elementId: $elementId, file: $path})
        SET s.startLine = $startLine,
            s.preview = $preview,
            s.uid = $uid
      `, {
        elementId, path: relativePath,
        startLine: ladybug.int(startLine), preview, uid
      });

      if (enclosingFunc) {
        await session.run(`
          MATCH (s:${label} {elementId: $elementId, file: $path})
          MATCH (fn:Function {name: $funcName, file: $path, owner: $funcOwner})
          MERGE (fn)-[:CONTAINS_STMT]->(s)
        `, { elementId, path: relativePath, funcName: enclosingFunc, funcOwner: enclosingOwner });
      }
    }
  }
}

/**
 * The type a declaration writes down, or null where the language writes none.
 *
 * Read off the AST's `type:` field rather than inferred from a value: a
 * dataclass field (`lat: float`) carries its type there and nowhere else, and
 * without it every value class in a class diagram renders as a list of bare
 * names. Only the declaration's own node and its immediate parent are
 * consulted — walking further up would start borrowing an enclosing
 * declaration's type and confidently print the wrong one.
 */
function readDeclaredType(node) {
  for (let cur = node && node.parent, hops = 0; cur && hops < 2; cur = cur.parent, hops++) {
    const t = cur.childForFieldName && cur.childForFieldName('type');
    if (t && t.text) {
      const text = t.text.replace(/^:\s*/, '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    }
  }
  return null;
}

async function extractAllVariables(session, cached, tree, relativePath, funcBounds, classBounds = []) {
  if (!cached.variableQuery) return;
  const matches = cached.variableQuery.matches(tree.rootNode);

  const seen = new Set();
  for (const match of matches) {
    for (const capture of match.captures) {
      const isParam = capture.name === 'param_name';
      // `self.limit = …` — an instance field, not a local. It gets its own scope
      // and hangs off the CLASS rather than the method that happened to assign
      // it, because "which fields does this class have" is a question about the
      // class. Python has no declaration site for fields, so the assignments
      // are all there is to go on.
      const isField = capture.name === 'field_name';
      const name = capture.node.text;
      // `self`/`cls` are the receiver, not data — one Variable node per method
      // for them is noise, exactly as `this` is in JS.
      if (!name || name === 'this' || name === 'self' || name === 'cls') continue;

      const startLine = capture.node.startPosition.row + 1;
      const col = capture.node.startPosition.column;
      const enclosingBound = findEnclosingFunctionBound(funcBounds, capture.node.startIndex);
      const enclosingFunc = enclosingBound ? enclosingBound.name : null;
      const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
      const enclosingClass = findEnclosingClass(classBounds, capture.node.startIndex);
      // A bare assignment sitting in a class body but in no method is a class
      // attribute — which is how a dataclass declares ALL of its fields
      // (`class LaneSlot: idx: int`). Those are `left: (identifier)`, not
      // `self.x`, so without this they were filed as loose top-level variables
      // and every dataclass looked like it had no fields at all.
      const isClassAttr = !isParam && !isField && !enclosingFunc && !!enclosingClass;
      const belongsToClass = (isField || isClassAttr) && enclosingClass;
      const scope = isParam ? 'param'
        : (isField || isClassAttr) ? 'field'
          : (enclosingFunc ? 'local' : 'top');
      const elementId = `${name}:${startLine}:${col}`;
      const dedupe = `${relativePath}::${elementId}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      const uid = makeUid('Variable', elementId, relativePath);

      const declaredType = readDeclaredType(capture.node);

      await session.run(`
        MERGE (v:Variable {elementId: $elementId, file: $path})
        SET v.name = $name,
            v.scope = $scope,
            v.startLine = $startLine,
            v.declaredType = $declaredType,
            v.uid = $uid
      `, {
        elementId, path: relativePath, name, scope,
        startLine: ladybug.int(startLine), declaredType, uid
      });

      if (belongsToClass) {
        await session.run(`
          MATCH (v:Variable {elementId: $elementId, file: $path})
          MATCH (cls:Class {name: $className, file: $path})
          MERGE (cls)-[:DECLARES]->(v)
        `, { elementId, path: relativePath, className: enclosingClass });
      } else if (enclosingFunc) {
        await session.run(`
          MATCH (v:Variable {elementId: $elementId, file: $path})
          MATCH (fn:Function {name: $funcName, file: $path, owner: $funcOwner})
          MERGE (fn)-[:DECLARES]->(v)
        `, { elementId, path: relativePath, funcName: enclosingFunc, funcOwner: enclosingOwner });
      } else {
        await session.run(`
          MATCH (v:Variable {elementId: $elementId, file: $path})
          MATCH (f:File {path: $path})
          MERGE (f)-[:DECLARES]->(v)
        `, { elementId, path: relativePath });
      }
    }
  }
}

async function extractAST(session, cached, tree, relativePath, funcBounds) {
  if (!cached.astQuery) return;
  const matches = cached.astQuery.matches(tree.rootNode);

  const items = [];
  const seen = new Set();
  for (const match of matches) {
    for (const capture of match.captures) {
      const label = capture.name;
      const node = capture.node;
      const startLine = node.startPosition.row + 1;
      const endLine = node.endPosition.row + 1;
      const col = node.startPosition.column;
      const elementId = `${label}:${startLine}:${col}:${node.endPosition.column}`;
      const dedupe = `${relativePath}::${elementId}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);

      const enclosingBound = findEnclosingFunctionBound(funcBounds, node.startIndex);
      const enclosingFunc = enclosingBound ? enclosingBound.name : null;
      const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
      let preview = node.text.replace(/\s+/g, ' ').substring(0, 120);

      let value = null;
      if (label === 'StringLiteral') {
        value = node.text.replace(/^['"`]|['"`]$/g, '').substring(0, 200);
      } else if (label === 'NumberLiteral') {
        value = node.text.substring(0, 40);
      }

      items.push({
        label,
        elementId,
        startLine,
        endLine,
        col,
        preview,
        value,
        enclosingFunc,
        uid: makeUid(label, elementId, relativePath)
      });
    }
  }

  if (items.length === 0) return;

  // Group by label so each batch can apply a static label
  const byLabel = {};
  for (const it of items) {
    (byLabel[it.label] ||= []).push(it);
  }

  const CHUNK = 500;

  for (const [label, batch] of Object.entries(byLabel)) {
    for (let i = 0; i < batch.length; i += CHUNK) {
      const slice = batch.slice(i, i + CHUNK);
      await session.run(`
        UNWIND $rows AS row
        MERGE (n:ASTNode {elementId: row.elementId, file: $path})
        SET n:${label},
            n.startLine = row.startLine,
            n.endLine = row.endLine,
            n.col = row.col,
            n.preview = row.preview,
            n.value = row.value,
            n.uid = row.uid
      `, {
        path: relativePath,
        rows: slice.map(it => ({
          elementId: it.elementId,
          startLine: ladybug.int(it.startLine),
          endLine: ladybug.int(it.endLine),
          col: ladybug.int(it.col),
          preview: it.preview,
          value: it.value,
          uid: it.uid
        }))
      });
    }
  }

  // Link to enclosing function (or file) via [:CONTAINS_AST]
  const inFunc = items.filter(it => it.enclosingFunc);
  const atFile = items.filter(it => !it.enclosingFunc);

  for (let i = 0; i < inFunc.length; i += CHUNK) {
    const slice = inFunc.slice(i, i + CHUNK);
    await session.run(`
      UNWIND $rows AS row
      MATCH (n:ASTNode {elementId: row.elementId, file: $path})
      MATCH (fn:Function {name: row.fn, file: $path})
      MERGE (fn)-[:CONTAINS_AST]->(n)
    `, {
      path: relativePath,
      rows: slice.map(it => ({ elementId: it.elementId, fn: it.enclosingFunc }))
    });
  }
  for (let i = 0; i < atFile.length; i += CHUNK) {
    const slice = atFile.slice(i, i + CHUNK);
    await session.run(`
      UNWIND $rows AS row
      MATCH (n:ASTNode {elementId: row.elementId, file: $path})
      MATCH (f:File {path: $path})
      MERGE (f)-[:CONTAINS_AST]->(n)
    `, {
      path: relativePath,
      rows: slice.map(it => ({ elementId: it.elementId }))
    });
  }

  // Free per-file working set explicitly so V8 can collect before next file
  items.length = 0;
  seen.clear();
}

async function extractEffects(session, cached, tree, relativePath, funcBounds, graphMod) {
  if (!cached.hookEffectQuery) return;

  const HOOK_NAMES = new Set(['useEffect', 'useMemo', 'useCallback']);
  const matches = cached.hookEffectQuery.matches(tree.rootNode);

  for (const match of matches) {
    let hookName = null;
    let depsNode = null;

    for (const capture of match.captures) {
      if (capture.name === 'hook_name') hookName = capture.node.text;
      if (capture.name === 'deps_array') depsNode = capture.node;
    }

    if (!hookName || !HOOK_NAMES.has(hookName)) continue;

    const deps = [];
    if (depsNode) {
      for (let i = 0; i < depsNode.childCount; i++) {
        const child = depsNode.child(i);
        if (child.type === 'identifier') {
          deps.push(child.text);
        } else if (child.type === 'member_expression') {
          const root = child.child(0);
          if (root && root.type === 'identifier') deps.push(root.text);
        }
      }
    }

    const enclosingBound = findEnclosingFunctionBound(funcBounds, match.captures[0].node.startIndex);
    const enclosingFunc = enclosingBound ? enclosingBound.name : null;
    const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
    const startLine = match.captures[0].node.startPosition.row + 1;
    const uid = makeUid('Effect', `${relativePath}:${hookName}:${startLine}`, relativePath);

    await session.run(`
      MERGE (eff:Effect {uid: $uid})
      SET eff.hookType = $hookName,
          eff.file = $path,
          eff.startLine = $startLine,
          eff.deps = $deps
    `, { uid, hookName, path: relativePath, startLine: graphMod.int(startLine), deps });

    if (enclosingFunc) {
      await session.run(`
        MATCH (eff:Effect {uid: $uid})
        MATCH (func:Function {name: $funcName, file: $path, owner: $funcOwner})
        MERGE (func)-[:HAS_EFFECT]->(eff)
      `, { uid, funcName: enclosingFunc, funcOwner: enclosingOwner, path: relativePath });
    }

    for (const dep of deps) {
      await session.run(`
        MATCH (eff:Effect {uid: $uid})
        OPTIONAL MATCH (s:State {name: $dep, file: $path})
        WITH eff, s
        WHERE s IS NOT NULL
        MERGE (eff)-[:WATCHES]->(s)
      `, { uid, dep, path: relativePath });
    }
  }
}

async function extractAliases(session, cached, tree, relativePath, funcBounds) {
  if (!cached.aliasQuery) return;

  const matches = cached.aliasQuery.matches(tree.rootNode);
  for (const match of matches) {
    let aliasName = null;
    let originalName = null;

    for (const capture of match.captures) {
      if (capture.name === 'alias_name') aliasName = capture.node.text;
      if (capture.name === 'original_name') originalName = capture.node.text;
    }

    if (!aliasName || !originalName) continue;
    if (aliasName === originalName) continue;
    if (['true', 'false', 'null', 'undefined', 'this'].includes(originalName)) continue;

    const enclosingBound = findEnclosingFunctionBound(funcBounds, match.captures[0].node.startIndex);
    const enclosingFunc = enclosingBound ? enclosingBound.name : null;
    const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';

    await session.run(`
      OPTIONAL MATCH (original:Function {name: $originalName})
      WHERE original.file = $path OR EXISTS { MATCH (:File {path: $path})-[:IMPORTS]->(:File {path: original.file}) }
      WITH original WHERE original IS NOT NULL
      MERGE (alias:Alias {name: $aliasName, file: $path})
      SET alias.enclosingFunc = $enclosingFunc
      MERGE (alias)-[:ALIAS_OF]->(original)
    `, { aliasName, originalName, path: relativePath, enclosingFunc });
  }
}

async function extractCallbacks(session, cached, tree, relativePath, funcBounds) {
  if (!cached.callbackQuery) return;

  const matches = cached.callbackQuery.matches(tree.rootNode);
  if (matches.length === 0) return;

  // One (memoized) candidate fetch per file instead of one EXISTS-subquery
  // scan per callback reference — see loadFunctionCandidates.
  const targetsByName = await loadFunctionCandidates(session, relativePath);
  const localBindings = await loadLocalBindings(session, relativePath);
  const callbackAliases = relativePath.endsWith('.py')
    ? pythonScopedAliases(tree.rootNode, funcBounds)
    : new Map();
  const callbackParams = new Set();
  if (relativePath.endsWith('.py') && cached.variableQuery) {
    for (const match of cached.variableQuery.matches(tree.rootNode)) {
      for (const capture of match.captures) {
        if (capture.name !== 'param_name') continue;
        const scope = findEnclosingFunction(funcBounds, capture.node.startIndex);
        if (scope) callbackParams.add(`${scope}|${capture.node.text}`);
      }
    }
  }

  const seenEdges = new Set();
  for (const match of matches) {
    let callerName = null;
    let callbackRef = null;
    let callbackNode = null;

    for (const capture of match.captures) {
      if (capture.name === 'caller_func' || capture.name === 'caller_method') {
        callerName = capture.node.text;
      }
      if (capture.name === 'callback_ref') { callbackRef = capture.node.text; callbackNode = capture.node; }
    }

    if (!callbackRef) continue;
    if (['true', 'false', 'null', 'undefined', 'this', 'console'].includes(callbackRef)) continue;
    if (callbackRef.length <= 1) continue;

    const enclosingBound = findEnclosingFunctionBound(funcBounds, match.captures[0].node.startIndex);
    const enclosingFunc = enclosingBound ? enclosingBound.name : null;
    const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
    // No enclosing function → there is no caller node to attach to.
    if (!enclosingFunc) continue;
    // The name is bound locally here, so it refers to that binding and not to
    // the same-named function elsewhere — see loadLocalBindings.
    const bindingKey = `${enclosingFunc}|${callbackRef}`;
    const aliasedCallback = callbackAliases.get(bindingKey) ||
      (!callbackParams.has(bindingKey) ? callbackAliases.get(`<module>|${callbackRef}`) : null);
    if (callbackParams.has(bindingKey)) continue;
    if (localBindings.has(`${enclosingFunc}|${callbackRef}`) && !aliasedCallback) continue;

    const targetName = aliasedCallback || callbackRef;

    const targetFiles = targetsByName.get(targetName);
    const selectedTarget = selectUnambiguousCallbackTarget(targetFiles, relativePath);
    if (!targetFiles) continue; // not a known function → never produced an edge

    for (const targetFile of selectedTarget ? [selectedTarget] : []) {
      const via = callerName || 'direct';
      let argumentIndex = null;
      let directArg = callbackNode;
      while (directArg?.parent && directArg.parent.type !== 'argument_list' && directArg.parent.type !== 'arguments') directArg = directArg.parent;
      const argumentList = directArg?.parent;
      if (argumentList) {
        const named = argumentList.namedChildren || [];
        const index = named.findIndex(node => node.startIndex === directArg.startIndex && node.endIndex === directArg.endIndex);
        if (index >= 0) argumentIndex = index;
      }
      const edgeKey = `${enclosingFunc}->${targetName}@${targetFile}#${via}`;
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      await session.run(`
        MATCH (caller:Function {name: $enclosingFunc, file: $path, owner: $callerOwner})
        MATCH (target:Function {name: $callbackRef, file: $targetFile})
        MERGE (caller)-[r:PASSES_CALLBACK]->(target)
        SET r.via = $callerName, r.argumentIndex = $argumentIndex,
            r.confidence = 'high', r.resolvedBy = 'local-or-imported-symbol'
      `, { callbackRef: targetName, targetFile, path: relativePath, enclosingFunc, callerOwner: enclosingOwner, callerName: via,
           argumentIndex });
    }
  }
}

async function extractConditionalCalls(session, cached, tree, relativePath, funcBounds) {
  if (!cached.conditionalCallQuery) return;
  if (!cached.callQuery) return;

  const matches = cached.conditionalCallQuery.matches(tree.rootNode);
  if (matches.length === 0) return;
  const candidates = await loadFunctionCandidates(session, relativePath);
  for (const match of matches) {
    let conditionText = null;
    let thenNode = null;
    let elseNode = null;

    for (const capture of match.captures) {
      if (capture.name === 'condition' || capture.name === 'tern_condition') {
        conditionText = capture.node.text.substring(0, 80);
      }
      if (capture.name === 'then_branch' || capture.name === 'tern_then') {
        thenNode = capture.node;
      }
      if (capture.name === 'else_branch' || capture.name === 'tern_else') {
        elseNode = capture.node;
      }
    }

    if (!conditionText) continue;

    const enclosingBound = findEnclosingFunctionBound(funcBounds, match.captures[0].node.startIndex);
    const enclosingFunc = enclosingBound ? enclosingBound.name : null;
    const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
    if (!enclosingFunc) continue;

    const extractCallsInBranch = (branchNode, branchLabel) => {
      if (!branchNode) return [];
      const branchText = branchNode.text;
      const callPattern = /\b([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
      const calls = [];
      let m;
      while ((m = callPattern.exec(branchText)) !== null) {
        const name = m[1];
        if (['if', 'else', 'for', 'while', 'switch', 'return', 'new', 'typeof', 'void', 'delete', 'throw', 'catch', 'console'].includes(name)) continue;
        calls.push({ name, branch: branchLabel });
      }
      return calls;
    };

    const thenCalls = extractCallsInBranch(thenNode, 'then');
    const elseCalls = elseNode ? extractCallsInBranch(elseNode, 'else') : [];
    const allCalls = [...thenCalls, ...elseCalls];

    for (const call of allCalls) {
      const calleeFiles = candidates.get(call.name);
      if (!calleeFiles) continue;
      for (const calleeFile of calleeFiles) {
        await session.run(`
          MATCH (caller:Function {name: $callerName, file: $path, owner: $callerOwner})
          MATCH (callee:Function {name: $calleeName, file: $calleeFile})
          MERGE (caller)-[r:CALLS_CONDITIONALLY]->(callee)
          SET r.condition = $condition, r.branch = $branch
        `, {
          callerName: enclosingFunc, callerOwner: enclosingOwner, calleeName: call.name, calleeFile,
          path: relativePath, condition: conditionText, branch: call.branch
        });
      }
    }
  }
}

async function extractAsyncChains(session, cached, tree, relativePath, funcBounds) {
  if (!cached.asyncChainQuery) return;

  const CHAIN_METHODS = new Set(['then', 'catch', 'finally']);

  const matches = cached.asyncChainQuery.matches(tree.rootNode);
  if (matches.length === 0) return;
  const candidates = await loadFunctionCandidates(session, relativePath);
  for (const match of matches) {
    let chainMethod = null;
    let chainHandler = null;
    let awaitTarget = null;
    let spawnTarget = null;

    for (const capture of match.captures) {
      if (capture.name === 'chain_method') chainMethod = capture.node.text;
      if (capture.name === 'chain_handler') chainHandler = capture.node.text;
      if (capture.name === 'await_target') awaitTarget = capture.node.text;
      if (capture.name === 'spawn_target') spawnTarget = capture.node.text;
    }

    const enclosingBound = findEnclosingFunctionBound(funcBounds, match.captures[0].node.startIndex);
    const enclosingFunc = enclosingBound ? enclosingBound.name : null;
    const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
    if (!enclosingFunc) continue;

    if (chainMethod && CHAIN_METHODS.has(chainMethod) && chainHandler) {
      for (const handlerFile of candidates.get(chainHandler) || []) {
        await session.run(`
          MATCH (caller:Function {name: $callerName, file: $path, owner: $callerOwner})
          MATCH (handler:Function {name: $handlerName, file: $handlerFile})
          MERGE (caller)-[:ASYNC_CHAIN {method: $method}]->(handler)
        `, { callerName: enclosingFunc, callerOwner: enclosingOwner, handlerName: chainHandler, handlerFile, path: relativePath, method: chainMethod });
      }
    }

    if (awaitTarget) {
      for (const targetFile of candidates.get(awaitTarget) || []) {
        await session.run(`
          MATCH (caller:Function {name: $callerName, file: $path, owner: $callerOwner})
          MATCH (target:Function {name: $targetName, file: $targetFile})
          MERGE (caller)-[:AWAITS]->(target)
        `, { callerName: enclosingFunc, callerOwner: enclosingOwner, targetName: awaitTarget, targetFile, path: relativePath });
      }
    }

    if (spawnTarget) {
      for (const targetFile of candidates.get(spawnTarget) || []) {
        await session.run(`
          MATCH (caller:Function {name: $callerName, file: $path, owner: $callerOwner})
          MATCH (target:Function {name: $targetName, file: $targetFile})
          MERGE (caller)-[:SPAWNS]->(target)
        `, { callerName: enclosingFunc, callerOwner: enclosingOwner, targetName: spawnTarget, targetFile, path: relativePath });
      }
    }
  }
}

async function extractNamedImports(session, cached, tree, relativePath, allRelativePaths) {
  if (!cached.namedImportQuery) return;

  const matches = cached.namedImportQuery.matches(tree.rootNode);
  for (const match of matches) {
    let importName = null;
    let importAlias = null;
    let importSource = null;

    for (const capture of match.captures) {
      if (capture.name === 'import_name') importName = capture.node.text;
      if (capture.name === 'import_alias') importAlias = capture.node.text;
      if (capture.name === 'import_source') importSource = capture.node.text;
    }

    if (!importName || !importSource) continue;

    const { resolved } = resolveImportPath(importSource, relativePath, allRelativePaths);
    if (!resolved) continue;

    const localName = importAlias || importName;

    await session.run(`
      MATCH (f:File {path: $fromFile})
      MERGE (sym:ImportedSymbol {localName: $localName, file: $fromFile})
      SET sym.originalName = $importName, sym.sourceFile = $resolved
      MERGE (f)-[:IMPORTS_SYMBOL]->(sym)
    `, { fromFile: relativePath, localName, importName, resolved });

    await session.run(`
      MATCH (sym:ImportedSymbol {localName: $localName, file: $fromFile})
      OPTIONAL MATCH (target:Function {name: $importName, file: $resolved})
      WITH sym, target WHERE target IS NOT NULL
      MERGE (sym)-[:RESOLVES_TO]->(target)
    `, { localName, fromFile: relativePath, importName, resolved });
  }
}

async function extractNamedExports(session, cached, tree, relativePath, allRelativePaths) {
  if (!cached.namedExportQuery) return;

  const matches = cached.namedExportQuery.matches(tree.rootNode);
  for (const match of matches) {
    let exportName = null;
    let exportAlias = null;
    let reexportSource = null;

    for (const capture of match.captures) {
      if (capture.name === 'export_name') exportName = capture.node.text;
      if (capture.name === 'export_alias') exportAlias = capture.node.text;
      if (capture.name === 'reexport_source') reexportSource = capture.node.text;
    }

    if (!exportName) continue;

    const publicName = exportAlias || exportName;

    if (reexportSource) {
      const { resolved } = resolveImportPath(reexportSource, relativePath, allRelativePaths);
      await session.run(`
        MATCH (f:File {path: $path})
        MERGE (exp:ExportedSymbol {publicName: $publicName, file: $path})
        SET exp.localName = $exportName, exp.reexportFrom = $resolved
        MERGE (f)-[:EXPORTS_SYMBOL]->(exp)
      `, { path: relativePath, publicName, exportName, resolved: resolved || reexportSource });
    } else {
      await session.run(`
        MATCH (f:File {path: $path})
        MERGE (exp:ExportedSymbol {publicName: $publicName, file: $path})
        SET exp.localName = $exportName
        MERGE (f)-[:EXPORTS_SYMBOL]->(exp)
      `, { path: relativePath, publicName, exportName });

      await session.run(`
        MATCH (exp:ExportedSymbol {publicName: $publicName, file: $path})
        OPTIONAL MATCH (func:Function {name: $exportName, file: $path})
        WITH exp, func WHERE func IS NOT NULL
        MERGE (exp)-[:RESOLVES_TO]->(func)
      `, { publicName, exportName, path: relativePath });
    }
  }
}

async function extractReactWrappers(session, cached, tree, relativePath, funcBounds, graphMod) {
  if (!cached.reactWrapperQuery) return;

  const WRAPPER_FUNCS = new Set(['memo', 'forwardRef', 'lazy', 'createContext']);

  const matches = cached.reactWrapperQuery.matches(tree.rootNode);
  for (const match of matches) {
    let componentName = null;
    let wrapperFunc = null;
    let wrappedRef = null;
    let params = null;
    let componentNameNode = null;

    for (const capture of match.captures) {
      if (capture.name === 'component_name') {
        componentName = capture.node.text;
        componentNameNode = capture.node;
      }
      if (capture.name === 'wrapper_func') wrapperFunc = capture.node.text;
    }

    if (!componentName || !wrapperFunc) continue;
    if (!WRAPPER_FUNCS.has(wrapperFunc)) continue;

    const funcNode = componentNameNode.parent || componentNameNode;
    let wrappedNode = funcNode.childForFieldName('value');
    const wrapperChain = [];

    // Immer das erste benannte Argument weiterverfolgen. So bleibt die Query
    // flach und dieselbe Logik deckt memo(forwardRef(lazy(...))) ebenso ab wie
    // den direkten memo(Component)-Fall.
    while (wrappedNode && wrappedNode.type === 'call_expression') {
      const callee = wrappedNode.childForFieldName('function');
      let currentWrapper = null;
      if (callee && callee.type === 'identifier') {
        currentWrapper = callee.text;
      } else if (callee && callee.type === 'member_expression') {
        const property = callee.childForFieldName('property');
        if (property) currentWrapper = property.text;
      }
      if (!currentWrapper || !WRAPPER_FUNCS.has(currentWrapper)) break;
      wrapperChain.push(currentWrapper);
      const args = wrappedNode.childForFieldName('arguments');
      wrappedNode = args && args.namedChildCount > 0 ? args.namedChild(0) : null;
    }

    if (wrappedNode && ['arrow_function', 'function_expression'].includes(wrappedNode.type)) {
      const parametersNode = wrappedNode.childForFieldName('parameters');
      const parameterNode = wrappedNode.childForFieldName('parameter');
      if (parametersNode) params = parametersNode.text;
      else if (parameterNode) params = `(${parameterNode.text})`;
    } else if (wrappedNode && wrappedNode.type === 'identifier') {
      wrappedRef = wrappedNode.text;
    }
    wrapperFunc = wrapperChain.join('>') || wrapperFunc;

    const startLine = funcNode.startPosition.row + 1;
    const endLine = funcNode.endPosition.row + 1;
    const uid = makeUid('Function', componentName, relativePath);

    await session.run(`
      MATCH (f:File {path: $path})
      MERGE (func:Function:Component {name: $componentName, file: $path})
      SET func.startLine = $startLine,
          func.endLine = $endLine,
          func.params = $params,
          func.uid = $uid,
          func.wrappedBy = $wrapperFunc
      MERGE (f)-[:CONTAINS]->(func)
    `, {
      path: relativePath, componentName, startLine: graphMod.int(startLine),
      endLine: graphMod.int(endLine), params: params || '()', uid, wrapperFunc
    });

    funcBounds.push({
      name: componentName,
      startIndex: funcNode.startIndex,
      endIndex: funcNode.endIndex
    });

    if (wrappedRef) {
      await session.run(`
        MATCH (wrapper:Function {name: $componentName, file: $path})
        OPTIONAL MATCH (wrapped:Function {name: $wrappedRef})
        WHERE wrapped.file = $path OR EXISTS { MATCH (:File {path: $path})-[:IMPORTS]->(:File {path: wrapped.file}) }
        WITH wrapper, wrapped WHERE wrapped IS NOT NULL
        MERGE (wrapper)-[:WRAPS]->(wrapped)
      `, { componentName, wrappedRef, path: relativePath });
    }
  }
}

async function extractDataFlow(session, tree, relativePath, funcBounds) {
  const sourceText = tree.rootNode.text;
  if (funcBounds.length === 0) return;

  // One (memoized) candidate fetch per file; only touch the DB for name pairs
  // that both resolve — see loadFunctionCandidates.
  const funcsByName = await loadFunctionCandidates(session, relativePath);
  const seenFlows = new Set();

  for (const fb of funcBounds) {
    const bodyText = sourceText.substring(fb.startIndex, fb.endIndex);

    const assignPattern = /\b(?:const|let|var)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=\s*(?:(?:await\s+)?([a-zA-Z_$][a-zA-Z0-9_$.]*)\s*\()/g;
    let m;
    while ((m = assignPattern.exec(bodyText)) !== null) {
      const varName = m[1];
      const sourceFuncRaw = m[2];
      const sourceFunc = sourceFuncRaw.includes('.') ? sourceFuncRaw.split('.').pop() : sourceFuncRaw;

      if (['if', 'for', 'while', 'switch', 'return', 'new', 'typeof', 'console'].includes(sourceFunc)) continue;

      const sourceFiles = funcsByName.get(sourceFunc);
      if (!sourceFiles) continue; // source not a known function → no edge possible

      const usagePattern = new RegExp(`\\b([a-zA-Z_$][a-zA-Z0-9_$]*)\\s*\\(.*\\b${varName}\\b`, 'g');
      let u;
      while ((u = usagePattern.exec(bodyText)) !== null) {
        const consumerFunc = u[1];
        if (['if', 'for', 'while', 'switch', 'return', 'new', 'typeof', 'console'].includes(consumerFunc)) continue;

        const consumerFiles = funcsByName.get(consumerFunc);
        if (!consumerFiles) continue;

        for (const sFile of sourceFiles) {
          for (const cFile of consumerFiles) {
            const flowKey = `${sourceFunc}@${sFile}->${consumerFunc}@${cFile}#${varName}#${fb.name}`;
            if (seenFlows.has(flowKey)) continue;
            seenFlows.add(flowKey);
            await session.run(`
              MATCH (source:Function {name: $sourceFunc, file: $sFile})
              MATCH (consumer:Function {name: $consumerFunc, file: $cFile})
              MERGE (source)-[:DATA_FLOWS_TO {via: $varName, inFunc: $enclosing}]->(consumer)
            `, { sourceFunc, consumerFunc, sFile, cFile, varName, enclosing: fb.name });
          }
        }
      }
    }
  }
}

function extractJsxSpreadProps(cached, tree, relativePath, funcBounds, deferredPropsMap) {
  if (!cached.jsxSpreadQuery) return;

  const matches = cached.jsxSpreadQuery.matches(tree.rootNode);
  for (const match of matches) {
    let componentName = null;
    let spreadVar = null;

    for (const capture of match.captures) {
      if (capture.name === 'component_name') componentName = capture.node.text;
      if (capture.name === 'spread_var') spreadVar = capture.node.text;
    }

    if (!componentName || !spreadVar) continue;
    if (componentName[0] !== componentName[0].toUpperCase()) continue;

    const enclosingBound = findEnclosingFunctionBound(funcBounds, match.captures[0].node.startIndex);
    const enclosingFunc = enclosingBound ? enclosingBound.name : null;
    const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
    if (!enclosingFunc || enclosingFunc === componentName) continue;

    const key = `${enclosingFunc}|${relativePath}|${componentName}`;
    if (!deferredPropsMap[key]) {
      deferredPropsMap[key] = {
        parentName: enclosingFunc,
        parentFile: relativePath,
        childName: componentName,
        props: [],
        spreadVars: []
      };
    }
    if (!deferredPropsMap[key].spreadVars) {
      deferredPropsMap[key].spreadVars = [];
    }
    if (!deferredPropsMap[key].spreadVars.includes(spreadVar)) {
      deferredPropsMap[key].spreadVars.push(spreadVar);
    }
  }
}

async function extractUseContext(session, cached, tree, relativePath, funcBounds) {
  if (!cached.useContextQuery) return;

  const matches = cached.useContextQuery.matches(tree.rootNode);
  for (const match of matches) {
    let contextName = null;

    for (const capture of match.captures) {
      if (capture.name === 'context_name') contextName = capture.node.text;
    }

    if (!contextName) continue;

    const enclosingBound = findEnclosingFunctionBound(funcBounds, match.captures[0].node.startIndex);
    const enclosingFunc = enclosingBound ? enclosingBound.name : null;
    const enclosingOwner = enclosingBound ? (enclosingBound.owner || '') : '';
    if (!enclosingFunc) continue;

    await session.run(`
      MERGE (ctx:Context {name: $contextName})
      WITH ctx
      MATCH (consumer:Function {name: $funcName, file: $path, owner: $funcOwner})
      MERGE (consumer)-[:CONSUMES_CONTEXT]->(ctx)
    `, { contextName, funcName: enclosingFunc, funcOwner: enclosingOwner, path: relativePath });
  }
}

async function extractClassInheritance(session, cached, tree, relativePath) {
  if (!cached.classInheritanceQuery) return;

  const matches = cached.classInheritanceQuery.matches(tree.rootNode);
  for (const match of matches) {
    let className = null;
    const baseClasses = [];

    for (const capture of match.captures) {
      if (capture.name === 'class_name') className = capture.node.text;
      if (capture.name === 'anonymous_class') className = anonymousDefaultClassName(tree, relativePath);
      if (capture.name === 'base_class') baseClasses.push(capture.node.text);
    }

    if (!className || baseClasses.length === 0) continue;

    for (const rawBaseName of baseClasses) {
      const baseName = rawBaseName.replace(/<.*$/s, '').split(/::|\./).pop().trim();
      const target = await resolveClassCandidate(
        session, relativePath, baseName, 'INHERITS'
      );
      if (target.status === 'ambiguous') continue;

      if (target.status === 'resolved') {
        await session.run(`
          MATCH (child:Class {name: $className, file: $path})
          MATCH (parent:Class {uid: $baseUid})
          MERGE (child)-[:INHERITS]->(parent)
        `, { className, path: relativePath, baseUid: target.candidate.uid });
        continue;
      }

      await session.run(`
        MATCH (child:Class {name: $className, file: $path})
        MERGE (base:ExternalBase {name: $baseName})
        MERGE (child)-[:INHERITS]->(base)
      `, { className, baseName, path: relativePath });
    }
  }
}

/**
 * Decorators — `@property`, `@abstractmethod`, `@app.route(...)`, `@pytest.fixture`.
 *
 * Two distinct things are recorded, because they answer different questions and
 * have different resolution odds:
 *
 *  - `decorators` as a property on the decorated node. Always written. Most
 *    decorators are builtins or come from a third-party package and will never
 *    be a node in this graph, but "is this an abstract method / a property / a
 *    fixture" is exactly what a reader wants to know and it was nowhere.
 *  - a DECORATED_BY edge, but only when the decorator name resolves to a
 *    function that actually exists here. Same discipline as INSTANTIATES: never
 *    invent a target.
 *
 * The decorated node may be a function or a class, so both are attempted.
 */
async function extractDecorators(session, cached, tree, relativePath) {
  if (!cached.decoratorQuery) return;

  const matches = cached.decoratorQuery.matches(tree.rootNode);
  if (matches.length === 0) return;

  // Collect first: a method with three decorators must produce one property
  // write, not three that overwrite each other.
  const byTarget = new Map();
  for (const match of matches) {
    let ref = null;
    let target = null;
    for (const capture of match.captures) {
      if (capture.name === 'decorator_ref') ref = capture.node.text;
      if (capture.name === 'decorated_name') target = capture.node.text;
    }
    if (!ref || !target) continue;
    if (!byTarget.has(target)) byTarget.set(target, []);
    if (!byTarget.get(target).includes(ref)) byTarget.get(target).push(ref);
  }

  const candidates = await loadFunctionCandidates(session, relativePath);

  for (const [target, refs] of byTarget) {
    await session.run(`
      MATCH (n {file: $path})
      WHERE (n:Function OR n:Class) AND n.name = $target
      SET n.decorators = $refs
    `, { path: relativePath, target, refs });

    for (const ref of refs) {
      // `@a.b.c` / `@mod.deco(...)` — the decorator is the last segment, the
      // same rule extractInstantiations uses for `pkg.Widget()`.
      const name = ref.split('.').pop().trim();
      const targetFiles = candidates.get(name);
      if (!targetFiles) continue;
      for (const targetFile of targetFiles) {
        await session.run(`
          MATCH (n {file: $path})
          WHERE (n:Function OR n:Class) AND n.name = $target
          MATCH (deco:Function {name: $name, file: $decoFile})
          MERGE (n)-[:DECORATED_BY]->(deco)
        `, { path: relativePath, target, name, decoFile: targetFile });
      }
    }
  }
}

async function applyPythonFunctionSemantics(session, tree, relativePath) {
  if (!relativePath.endsWith('.py')) return;
  const source = tree.rootNode.text;
  const allMatch = source.match(/__all__\s*=\s*[\[(]([\s\S]*?)[\])]/m);
  const explicitExports = new Set();
  if (allMatch) {
    for (const match of allMatch[1].matchAll(/["']([^"']+)["']/g)) explicitExports.add(match[1]);
  }
  const cliMain = /if\s+__name__\s*==\s*["']__main__["']\s*:[\s\S]{0,300}?\bmain\s*\(/m.test(source);
  const result = await session.run(
    `MATCH (f:Function {file: $path})
     RETURN f.name AS name, f.decorators AS decorators, f.bodySnippet AS bodySnippet`,
    { path: relativePath }
  );
  for (const record of result.records) {
    const name = record.get('name');
    const decorators = record.get('decorators') || [];
    const body = record.get('bodySnippet') || '';
    const semantics = pythonFunctionSemantics(name, decorators, body, explicitExports, cliMain);
    const { visibility, isFrameworkEntrypoint, entryPointKind, isAbstract, isPlannedStub } = semantics;
    await session.run(
      `MATCH (f:Function {name: $name, file: $path})
       SET f.visibility = $visibility,
           f.isFrameworkEntrypoint = $isFrameworkEntrypoint,
           f.entryPointKind = $entryPointKind,
           f.isAbstract = $isAbstract,
           f.isPlannedStub = $isPlannedStub`,
      { name, path: relativePath, visibility, isFrameworkEntrypoint, entryPointKind, isAbstract, isPlannedStub }
    );
  }
}

function pythonFunctionSemantics(name, decorators = [], body = '', explicitExports = new Set(), cliMain = false) {
    const decoratorText = decorators.join(' ').toLowerCase();
    let visibility = name.startsWith('_') && !/^__.*__$/.test(name) ? 'private' : 'public';
    if (explicitExports.size) visibility = explicitExports.has(name) ? 'public' : visibility;
    let isFrameworkEntrypoint = false;
    let entryPointKind = null;
    if (/^test_/.test(name)) { isFrameworkEntrypoint = true; entryPointKind = 'pytest-test'; }
    else if (/^pytest_/.test(name)) { isFrameworkEntrypoint = true; entryPointKind = 'pytest-hook'; }
    else if (decoratorText.includes('pytest.fixture')) { isFrameworkEntrypoint = true; entryPointKind = 'pytest-fixture'; }
    else if (decoratorText.includes('hydra.main')) { isFrameworkEntrypoint = true; entryPointKind = 'hydra-entrypoint'; }
    else if (name === 'main' && cliMain) { isFrameworkEntrypoint = true; entryPointKind = 'cli-entrypoint'; }
    const isAbstract = decoratorText.includes('abstractmethod') || decoratorText.includes('abc.abstract');
    const isPlannedStub = /\bNotImplementedError\b/.test(body);
    return { visibility, isFrameworkEntrypoint, entryPointKind, isAbstract, isPlannedStub };
}

/**
 * Every class name mentioned inside a type annotation.
 *
 * Walking beats enumerating query shapes here, because the grammar splits the
 * same annotation across node types on subtle grounds: `list[int]` is a
 * `generic_type` but `t.Optional[int]` is a `subscript` (the base is not a bare
 * identifier); `int | None` is a `binary_operator` but `list[int] | None` is a
 * `union_type`. Any query matching one of each pair silently misses the other.
 * An annotation contains nothing but type names, so a blanket identifier walk
 * has nothing to confuse.
 *
 * A forward reference (`x: "Obstacle"`) is a string whose contents the grammar
 * does not parse, so its names are pulled out textually — otherwise every
 * annotation written to break an import cycle would be invisible.
 */
function collectTypeNames(typeNode) {
  const names = [];
  const stack = [typeNode];
  while (stack.length) {
    const n = stack.pop();
    // Python schreibt einen Typnamen als `identifier`, TypeScript, Java und C++
    // als `type_identifier`. Ohne den zweiten Fall lieferte diese Funktion für
    // alles außer Python eine leere Liste -- die Abfragen hätten Treffer
    // gehabt, aus denen nie eine Kante entstand. Beide Formen sind derselbe
    // Gedanke: der Name, der in der Annotation steht.
    if (n.type === 'identifier' || n.type === 'type_identifier') names.push(n.text);
    if (n.type === 'string_content') {
      for (const m of n.text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) names.push(m[0]);
    }
    for (let i = 0; i < n.childCount; i++) stack.push(n.child(i));
  }
  return names;
}

/**
 * USES_TYPE — the association a type hint states outright.
 *
 * `def plan(self, obstacles: list[Obstacle]) -> Trajectory` says this function
 * depends on Obstacle and Trajectory. That was recorded only as a display
 * string on Function.return_type and never as an edge, so a generated class
 * diagram showed boxes whose relationships were spelled out in the source.
 *
 * Only names that are Classes in the graph produce an edge — `int`, `None` and
 * every third-party type resolve to nothing, which is the point.
 */
async function extractTypeReferences(session, cached, tree, relativePath, classBounds = []) {
  if (!cached.typeRefQuery) return;

  const matches = cached.typeRefQuery.matches(tree.rootNode);
  if (matches.length === 0) return;

  // Names only, and only to answer "is this annotation a project class at all?"
  // — `int`, `None` and every third-party type drop out here. WHICH class a
  // surviving name means is decided per edge below, against the file's imports.
  const knownClasses = new Set((await loadClassCatalog(session)).map((c) => c.name));

  // owner -> role -> Set(type). Deduplicated before touching the database: a
  // method taking the same type in three parameters is one edge.
  const edges = new Map();
  for (const match of matches) {
    let ownerName = null;
    let ownerKind = null;
    let typeNode = null;
    for (const capture of match.captures) {
      if (capture.name === 'owner_name') { ownerName = capture.node.text; ownerKind = 'function'; }
      if (capture.name === 'owner_field') { ownerName = capture.node.text; ownerKind = 'field'; }
      if (capture.name === 'type_ref') typeNode = capture.node;
    }
    if (!ownerName || !typeNode) continue;

    // The role is read off the annotation's position rather than tracked per
    // pattern: a return annotation hangs directly under the definition, a
    // parameter annotation under the parameter node.
    const role = typeNode.parent && typeNode.parent.type === 'function_definition'
      ? 'return'
      : (ownerKind === 'field' ? 'field' : 'param');

    // A field's dependency belongs to the class that owns it, not to the field.
    const holder = ownerKind === 'field'
      ? findEnclosingClass(classBounds, typeNode.startIndex)
      : ownerName;
    if (!holder) continue;
    const holderKind = ownerKind === 'field' ? 'Class' : 'Function';

    for (const typeName of collectTypeNames(typeNode)) {
      if (!knownClasses.has(typeName)) continue;
      if (typeName === holder) continue; // self-reference is noise, not an association
      const key = `${holderKind}|${holder}|${role}|${typeName}`;
      edges.set(key, { holderKind, holder, role, typeName });
    }
  }

  for (const { holderKind, holder, role, typeName } of edges.values()) {
    // Matching the target by NAME would hang the edge on whichever same-named
    // class the scan happened to reach first — the bug that same-named classes
    // in different packages caused everywhere else. Resolve through the file's
    // import context and address the target by uid; an ambiguous or unimported
    // name yields no edge, which is the honest answer.
    const resolved = await resolveClassCandidate(session, relativePath, typeName, 'USES_TYPE');
    if (resolved.status !== 'resolved') continue;
    await session.run(`
      MATCH (owner:${holderKind} {name: $holder, file: $path})
      MATCH (target:Class {uid: $targetUid})
      MERGE (owner)-[r:USES_TYPE {role: $role}]->(target)
    `, { holder, path: relativePath, targetUid: resolved.candidate.uid, role });
  }
}

// ============================================================
// DEFERRED EDGES — cross-file resolution
// ============================================================

async function insertDeferredEdges(session, deferredRenders, deferredPropsMap) {
  if (deferredRenders.length > 0) {
    console.log(`Inserting ${deferredRenders.length} RENDERS edges...`);
    for (const r of deferredRenders) {
      if (r.frameworkRoot) {
        await session.run(`
          MATCH (parent:File {path: $parentFile})
          MATCH (child:Function {name: $childName})
          WHERE child.file = $parentFile
             OR EXISTS { MATCH (:File {path: $parentFile})-[:IMPORTS]->(:File {path: child.file}) }
          SET child.isFrameworkEntrypoint = true, child.entryPointKind = 'react-root'
          MERGE (parent)-[:RENDERS]->(child)
        `, { parentFile: r.parentFile, childName: r.childName });
        continue;
      }
      await session.run(`
        MATCH (parent:Function {name: $parentName, file: $parentFile})
        MATCH (child:Function {name: $childName})
        WHERE child.file = $parentFile
           OR EXISTS { MATCH (:File {path: $parentFile})-[:IMPORTS]->(:File {path: child.file}) }
        MERGE (parent)-[:RENDERS]->(child)
      `, { parentName: r.parentName, parentFile: r.parentFile, childName: r.childName });
    }
  }

  const propEntries = Object.values(deferredPropsMap);
  if (propEntries.length > 0) {
    console.log(`Inserting ${propEntries.length} PASSES_PROP edges (aggregated)...`);
    for (const p of propEntries) {
      await session.run(`
        MATCH (parent:Function {name: $parentName, file: $parentFile})
        MATCH (child:Function {name: $childName})
        WHERE child.file = $parentFile
           OR EXISTS { MATCH (:File {path: $parentFile})-[:IMPORTS]->(:File {path: child.file}) }
        MERGE (parent)-[r:PASSES_PROP]->(child)
        SET r.props = $props, r.hasSpread = $hasSpread, r.spreadVars = $spreadVars
      `, {
        parentName: p.parentName, parentFile: p.parentFile, childName: p.childName,
        props: p.props,
        hasSpread: (p.spreadVars && p.spreadVars.length > 0) || false,
        spreadVars: p.spreadVars || []
      });
    }
  }
}

// ============================================================
// GLOBAL SYMBOL RESOLUTION — cross-file CALLS without imports
// ============================================================

async function resolveGlobalCalls(session) {
  // Resolve cross-file CALLS for browser-global projects (no import/require).
  //
  // Problem: extractCalls only creates CALLS edges when callee is in the same file
  // or an imported file. Browser globals have no imports → no cross-file CALLS.
  //
  // Solution: Two-phase approach
  //   Phase 1: Collect unresolved calls from extractCalls (stored during parsing)
  //   Phase 2: Match them against unique global function definitions
  //
  // Safety: Only activates for files with NO outgoing IMPORTS (pure global scope).
  // For module-based files, normal import resolution handles everything.

  // Phase 1: Find files that have no IMPORTS edges (browser-global files)
  const globalFilesResult = await session.run(
    `MATCH (f:File)
     WHERE NOT EXISTS { MATCH (f)-[:IMPORTS]->() }
     RETURN f.path AS path`,
    {}
  );
  if (!globalFilesResult || globalFilesResult.records.length === 0) return;

  const globalFiles = new Set(globalFilesResult.records.map(r => r.get('path')));

  // Phase 2: Build unique global symbol table (functions with exactly one definition)
  const funcResult = await session.run(
    `MATCH (f:Function)
     WITH f.name AS name, collect(DISTINCT f.file) AS files
     WHERE size(files) = 1
     RETURN name, files[0] AS file`,
    {}
  );
  if (!funcResult || funcResult.records.length === 0) return;

  const uniqueGlobals = Object.create(null);
  for (const r of funcResult.records) {
    uniqueGlobals[r.get('name')] = r.get('file');
  }

  // Phase 3: For each global file, read its source and find function calls
  // that reference unique global symbols from OTHER files
  let created = 0;

  for (const callerFile of globalFiles) {
    // Get all functions in this file and their existing CALLS targets
    const funcsInFile = await session.run(
      `MATCH (f:Function {file: $file})
       OPTIONAL MATCH (f)-[:CALLS]->(t)
       RETURN f.name AS funcName, collect(DISTINCT t.name) AS existingCalls`,
      { file: callerFile }
    );
    if (!funcsInFile) continue;

    // Read the actual source file to check which global names are referenced
    const fullPath = path.resolve(projectDir, callerFile);
    if (!fs.existsSync(fullPath)) continue;
    const source = fs.readFileSync(fullPath, 'utf-8');

    // Get line ranges for each function from the graph
    const lineRanges = await session.run(
      `MATCH (f:Function {file: $file}) RETURN f.name AS name, f.startLine AS startLine, f.endLine AS endLine`,
      { file: callerFile }
    );
    const funcLineMap = {};
    if (lineRanges) {
      for (const lr of lineRanges.records) {
        const sl = lr.get('startLine');
        const el = lr.get('endLine');
        funcLineMap[lr.get('name')] = {
          startLine: sl && sl.toNumber ? sl.toNumber() : sl,
          endLine: el && el.toNumber ? el.toNumber() : el
        };
      }
    }

    const sourceLines = source.split('\n');

    for (const rec of funcsInFile.records) {
      const callerName = rec.get('funcName');
      const existingCalls = rec.get('existingCalls') || [];
      const range = funcLineMap[callerName];

      // Extract only this function's body for call scanning
      let funcBody;
      if (range && range.startLine && range.endLine) {
        funcBody = sourceLines.slice(range.startLine - 1, range.endLine).join('\n');
      } else {
        continue; // No line range → can't isolate function body
      }

      // Find function calls in this function's body: identifier followed by (
      //
      // Ein Bezeichner mit Empfaenger davor ist KEIN Aufruf einer freien
      // Funktion. `self._cache.get(...)` heißt nicht, dass irgendwo eine
      // global eindeutige Funktion `get` gemeint ist -- und genau so entstanden
      // hier Kanten von Python nach Java und von TypeScript nach Java, weil
      // `Cache.get` zufällig der einzige Träger dieses Namens im ganzen
      // Projekt war. Diese Textsuche kann einen Empfaenger nicht auflösen,
      // also darf sie ihn auch nicht ignorieren: `.`, `::` und `->` schließen
      // den Treffer aus. Für Aufrufe MIT Empfaenger gibt es resolveCallee, das
      // den Typ kennt.
      const callPattern = /(^|[^.\w$])([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g;
      let match;
      const calledNames = new Set();
      while ((match = callPattern.exec(funcBody)) !== null) {
        const before = funcBody.slice(Math.max(0, match.index - 2), match.index + match[1].length);
        if (/(::|->)\s*$/.test(before)) continue;
        calledNames.add(match[2]);
      }

      // Sprachwechsel ist kein Aufruf. Diese Textsuche kennt weder Importe noch
      // Typen; ohne diese Schranke verband sie eine .py-Datei mit einer .java,
      // sobald beide einen Methodennamen teilen.
      const callerExt = String(callerFile).split('.').pop().toLowerCase();

      for (const calledName of calledNames) {
        // Skip: self-calls, already-connected, same-file functions, JS builtins
        if (calledName === callerName) continue;
        if (existingCalls.includes(calledName)) continue;
        if (!uniqueGlobals[calledName]) continue;
        if (uniqueGlobals[calledName] === callerFile) continue; // same file
        if (String(uniqueGlobals[calledName]).split('.').pop().toLowerCase() !== callerExt) continue;

        // Create cross-file CALLS edge
        await session.run(
          `MATCH (caller:Function {name: $callerName, file: $callerFile})
           MATCH (callee:Function {name: $calledName, file: $calleeFile})
           MERGE (caller)-[:CALLS {resolvedBy: 'global'}]->(callee)`,
          { callerName, callerFile, calledName, calleeFile: uniqueGlobals[calledName] }
        );
        created++;
      }
    }
  }

  if (created > 0) {
    console.log(`Global symbol resolution: created ${created} cross-file CALLS edge(s).`);
  }
}

// ============================================================
// PARSE HELPER — shared by full and diff mode
// ============================================================

/**
 * Resolve a grammar's .wasm to an absolute path.
 *
 * The LANG_CONFIGS carry paths like '../node_modules/tree-sitter-go/tree-sitter-go.wasm',
 * which only resolve when CodeVis runs from its own checkout. Installed as a
 * dependency, npm hoists the grammars to the *host project's* node_modules, so
 * `<pkg>/node_modules/tree-sitter-go` does not exist. Asking Node's resolver for
 * the grammar's package.json finds it wherever it actually landed (hoisted,
 * nested, or pnpm-linked).
 */
function resolveGrammarWasm(rel) {
  const parts = rel.split('/').filter((p) => p && p !== '..' && p !== 'node_modules');
  const pkg = parts[0];
  const file = parts.slice(1).join('/');
  try {
    let packageRoot;
    try {
      const pkgJson = require.resolve(`${pkg}/package.json`, { paths: [__dirname] });
      packageRoot = path.dirname(pkgJson);
    } catch {
      // Packages with a strict `exports` map often hide package.json. Their
      // public entry point still gives us the package root without assuming
      // npm's node_modules layout.
      packageRoot = path.dirname(require.resolve(pkg, { paths: [__dirname] }));
    }
    return path.join(packageRoot, file);
  } catch {
    throw new Error(
      `Tree-sitter grammar '${pkg}' is not installed — cannot parse this language. ` +
      `Install it in your project: npm install ${pkg}`
    );
  }
}

/**
 * @param {Record<string, boolean>} extractors Which optional extractors run —
 *        see scripts/extractors.cjs. Defaults to everything on so a caller that
 *        does not care (tests, tooling) behaves like the core builder.
 */
async function parseFiles(session, files, baseDir, allRelativePaths, langCache, parser, extractors = {}) {
  const rosEnabled = extractors.ros !== false;
  const deferredRenders = [];
  const deferredPropsMap = {};
  const parsedFilesInfo = [];
  const progress = createParseProgress(files, baseDir);

  for (const [fileIndex, file] of files.entries()) {
    const ext = path.extname(file);
    const langConfig = LANG_CONFIGS[ext];
    if (!langConfig) continue;

    // Snapshot the timestamp before reading. Grammar loading below can await;
    // edits during that time must not stamp old content with a newer timestamp.
    const sourceMtime = Math.ceil(fs.statSync(file).mtimeMs);
    const content = fs.readFileSync(file, 'utf8');
    const relativePath = relGraphPath(baseDir, file);

    if (!langCache[ext]) {
      const wasmPath = resolveGrammarWasm(langConfig.wasm);
      const lang = await Language.load(wasmPath);
      langCache[ext] = {
        lang,
        funcQuery: safeQuery(lang, langConfig.funcQuery),
        callQuery: safeQuery(lang, langConfig.callQuery),
        attributeTypeQuery: safeQuery(lang, langConfig.attributeTypeQuery),
        classQuery: safeQuery(lang, langConfig.classQuery),
        stateQuery: safeQuery(lang, langConfig.stateQuery),
        returnQuery: safeQuery(lang, langConfig.returnQuery),
        importQuery: safeQuery(lang, langConfig.importQuery),
        requireQuery: safeQuery(lang, langConfig.requireQuery),
        jsxQuery: safeQuery(lang, langConfig.jsxQuery),
        jsxComponentQuery: safeQuery(lang, langConfig.jsxComponentQuery),
        jsxPropQuery: safeQuery(lang, langConfig.jsxPropQuery),
        httpQuery: safeQuery(lang, langConfig.httpQuery),
        // Gated at COMPILE time, not just at call time: a disabled vertical must
        // not cost anything, and a query that is never compiled cannot quietly
        // start matching again through some other code path.
        rosTopicQuery: rosEnabled ? safeQuery(lang, langConfig.rosTopicQuery) : null,
        rosInterfaceQuery: rosEnabled ? safeQuery(lang, langConfig.rosInterfaceQuery) : null,
        rosNodeNameQuery: rosEnabled ? safeQuery(lang, langConfig.rosNodeNameQuery) : null,
        // rosLang drives the semantics module (scripts/ros/ros_model.js). Without
        // it the extractor returns immediately — which is exactly what a disabled
        // extractor should do, and it means the gate cannot be half-applied.
        rosLang: rosEnabled ? (langConfig.rosLang || null) : null,
        hookEffectQuery: safeQuery(lang, langConfig.hookEffectQuery),
        aliasQuery: safeQuery(lang, langConfig.aliasQuery),
        callbackQuery: safeQuery(lang, langConfig.callbackQuery),
        conditionalCallQuery: safeQuery(lang, langConfig.conditionalCallQuery),
        asyncChainQuery: safeQuery(lang, langConfig.asyncChainQuery),
        namedImportQuery: safeQuery(lang, langConfig.namedImportQuery),
        namedExportQuery: safeQuery(lang, langConfig.namedExportQuery),
        reactWrapperQuery: safeQuery(lang, langConfig.reactWrapperQuery),
        jsxSpreadQuery: safeQuery(lang, langConfig.jsxSpreadQuery),
        useContextQuery: safeQuery(lang, langConfig.useContextQuery),
        classInheritanceQuery: safeQuery(lang, langConfig.classInheritanceQuery),
        instantiationQuery: safeQuery(lang, langConfig.instantiationQuery),
        controlFlowQuery: safeQuery(lang, langConfig.controlFlowQuery),
        statementQuery: safeQuery(lang, langConfig.statementQuery),
        variableQuery: safeQuery(lang, langConfig.variableQuery),
        decoratorQuery: safeQuery(lang, langConfig.decoratorQuery),
        typeRefQuery: safeQuery(lang, langConfig.typeRefQuery),
        moduleAliasQuery: safeQuery(lang, langConfig.moduleAliasQuery),
        astQuery: safeQuery(lang, langConfig.astQuery)
      };
    }

    const cached = langCache[ext];
    parser.setLanguage(cached.lang);

    const tree = parseSource(parser, content, relativePath);
    const parseStatus = tree.rootNode.hasError ? 'parse_error' : 'current';

    // ceil: mtimeMs is a float; the INT64 column rounds it on store, and a
    // truncated-down value makes `mtime > lastParsed` true forever — half the
    // codebase re-parsed on every "diff" run. Ceiling keeps unchanged files
    // unchanged and a real later edit still compares greater.
    const parsedAt = Date.now();
    const contentHash = createHash('sha256').update(content).digest('hex');
    const fileUid = makeUid('File', relativePath, '');
    await session.run(
      `MERGE (f:File {path: $path})
       SET f.language = $lang, f.lastParsed = $sourceMtime,
           f.sourceMtime = $sourceMtime, f.parsedAt = $parsedAt,
           f.contentHash = $contentHash, f.parseStatus = $parseStatus,
           f.uid = $uid, f.updatedAt = $parsedAt RETURN f`,
      { path: relativePath, lang: ext.substring(1), sourceMtime, parsedAt, contentHash, parseStatus, uid: fileUid }
    );
    if (parseStatus === 'parse_error') console.warn(`[parse] ${relativePath} contains syntax errors; confidence-sensitive analyses will remain suppressed.`);

    // PASS 1: Structural nodes
    // Candidate memo must not survive into this file's re-parse — the
    // Function nodes are about to change.
    invalidateFunctionCandidates();
    // This pass creates classes and imports. Resolution starts with a fresh
    // catalog/context once pass 2 has all structural nodes available.
    invalidateClassResolution();
    const classBounds = await extractClasses(session, cached, tree, relativePath, ladybug);
    const funcBounds = await extractFunctions(session, cached, tree, relativePath, ladybug, classBounds);
    await extractReactWrappers(session, cached, tree, relativePath, funcBounds, ladybug);
    await extractImports(session, cached, tree, relativePath, allRelativePaths);
    await extractNamedImports(session, cached, tree, relativePath, allRelativePaths);
    await extractNamedExports(session, cached, tree, relativePath, allRelativePaths);
    await extractHttpEndpoints(session, cached, tree, relativePath, funcBounds);
    parsedFilesInfo.push({ cached, tree, relativePath, funcBounds, classBounds });
    progress.update('Parse', fileIndex + 1, relativePath);
  }

  // PASS 2: Relational dependencies (targets must exist in the graph)
  invalidateClassResolution();
  await linkAndroidManifestComponents(session, parsedFilesInfo);

  for (const info of parsedFilesInfo) {
    await extractClassInheritance(session, info.cached, info.tree, info.relativePath);
    await linkOutOfLineMethods(session, info.relativePath, info.funcBounds);
  }

  // Mark every ROS subclass first. Otherwise an alphabetically earlier .cpp
  // can try to set an out-of-line constructor name before its .hpp declaration
  // has isRosNode=true.
  if (rosEnabled) {
    for (const info of parsedFilesInfo) {
      await extractRosNodes(
        session, info.cached, info.tree, info.relativePath, info.classBounds,
        { markOnly: true }
      );
    }
  }

  for (const [fileIndex, info] of parsedFilesInfo.entries()) {
    await extractStates(session, info.cached, info.tree, info.relativePath, info.funcBounds);
    await extractCalls(
      session, info.cached, info.tree, info.relativePath, info.funcBounds, info.classBounds
    );
    await extractReturns(session, info.cached, info.tree, info.relativePath, info.funcBounds);
    if (rosEnabled) {
      await extractRosNodes(
        session, info.cached, info.tree, info.relativePath, info.classBounds,
        { namesOnly: true }
      );
      await extractRosInterfaces(session, info.cached, info.tree, info.relativePath, info.funcBounds, info.classBounds);
    }
    await extractInstantiations(session, info.cached, info.tree, info.relativePath, info.funcBounds);
    await extractDOMElements(session, info.cached, info.tree, info.relativePath, info.funcBounds);
    await extractControlFlow(session, info.cached, info.tree, info.relativePath, info.funcBounds);
    await extractStatements(session, info.cached, info.tree, info.relativePath, info.funcBounds);
    await extractAllVariables(session, info.cached, info.tree, info.relativePath, info.funcBounds, info.classBounds);
    // Both need the whole graph to resolve against — decorators against the
    // functions reachable from this file, type hints against every known class —
    // so they belong in pass 2, after all files have contributed their nodes.
    await extractDecorators(session, info.cached, info.tree, info.relativePath);
    await applyPythonFunctionSemantics(session, info.tree, info.relativePath);
    await extractTypeReferences(session, info.cached, info.tree, info.relativePath, info.classBounds);
    await extractAST(session, info.cached, info.tree, info.relativePath, info.funcBounds);
    await extractEffects(session, info.cached, info.tree, info.relativePath, info.funcBounds, ladybug);
    await extractAliases(session, info.cached, info.tree, info.relativePath, info.funcBounds);
    await extractCallbacks(session, info.cached, info.tree, info.relativePath, info.funcBounds);
    await extractConditionalCalls(session, info.cached, info.tree, info.relativePath, info.funcBounds);
    await extractAsyncChains(session, info.cached, info.tree, info.relativePath, info.funcBounds);
    await extractDataFlow(session, info.tree, info.relativePath, info.funcBounds);
    await extractUseContext(session, info.cached, info.tree, info.relativePath, info.funcBounds);
    extractJsxRenders(info.cached, info.tree, info.relativePath, info.funcBounds, deferredRenders);
    extractJsxProps(info.cached, info.tree, info.relativePath, info.funcBounds, deferredPropsMap);
    extractJsxSpreadProps(info.cached, info.tree, info.relativePath, info.funcBounds, deferredPropsMap);
    progress.update('Analyze', fileIndex + 1, info.relativePath);
  }

  progress.finish();

  return { deferredRenders, deferredPropsMap };
}

function formatProgressBar(current, total, width = 24) {
  const ratio = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  const filled = Math.round(ratio * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function summarizeExtensions(files) {
  const counts = new Map();
  for (const file of files) {
    const extension = path.extname(file).slice(1).toLowerCase() || 'other';
    counts.set(extension, (counts.get(extension) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function createParseProgress(files, baseDir, stream = process.stdout) {
  const total = files.length;
  const interactive = Boolean(stream.isTTY && typeof stream.clearLine === 'function');
  const startedAt = Date.now();
  let activePhase = null;

  const update = (phase, current, file) => {
    if (!interactive) {
      if (phase !== activePhase) console.log(`  ${phase.padEnd(8)} ${total} file(s)`);
      activePhase = phase;
      return;
    }
    activePhase = phase;
    const percent = total > 0 ? Math.round((current / total) * 100) : 100;
    const relative = file || relGraphPath(baseDir, files[current - 1] || '');
    const available = Math.max(16, (stream.columns || 100) - 55);
    const label = relative.length > available ? `…${relative.slice(-(available - 1))}` : relative;
    stream.clearLine(0);
    stream.cursorTo(0);
    stream.write(`  ${phase.padEnd(8)} ${formatProgressBar(current, total)} ${String(percent).padStart(3)}%  ${label}`);
  };

  const finish = () => {
    if (interactive && activePhase) stream.write('\n');
    const distribution = summarizeExtensions(files);
    const max = distribution[0]?.[1] || 0;
    console.log('  Languages');
    for (const [extension, count] of distribution) {
      console.log(`    ${extension.padEnd(8)} ${formatProgressBar(count, max, 16)} ${String(count).padStart(5)}`);
    }
    console.log(`  Complete   ${total} file(s) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  };

  return { update, finish };
}

// ============================================================
// MAIN — supports 'full' (default) and 'diff' mode
// Usage:
//   node graph_builder.js <target> [diff]
// ============================================================

async function main() {
  const targetName = process.argv[2];
  const mode = process.argv[3]; // optional: 'diff'
  let isDiffMode = mode === 'diff';

  const validTargets = Object.keys(config.workspaces);
  if (!targetName || !validTargets.includes(targetName)) {
    console.error(`Please provide a target: ${validTargets.map(k => `'${k}'`).join(' or ')}`);
    process.exit(1);
  }

  const workspaceConfig = config.workspaces[targetName];
  if (!workspaceConfig) {
    console.error(`Configuration for workspace '${targetName}' not found.`);
    process.exit(1);
  }

  const { sourceDir, auth, exclude } = workspaceConfig;
  // dbUri is the current name; neo4jUri is still accepted so configs written
  // by an older `codevis init` keep working.
  const dbUri = workspaceConfig.dbUri || workspaceConfig.neo4jUri;
  const baseDir = projectDir;
  const identity = paths.workspaceIdentityStatus(config, targetName);
  const dbPath = paths.DB_PATHS[normalizeWorkspaceName(targetName)];
  const journalPath = `${dbPath}.rebuild-recovery.json`;
  const { readJournal, writeJournal } = require('../lib/rebuild-journal.cjs');
  const pendingRecovery = readJournal(journalPath);
  if (pendingRecovery) {
    if (pendingRecovery.identity !== identity.expected.fingerprint) {
      throw new Error('Pending rebuild recovery belongs to different sources. Restore the previous sourceDir before retrying.');
    }
    isDiffMode = false;
    console.warn('[recovery] Completing interrupted full rebuild; authored links will be restored from disk.');
  }
  if (fs.existsSync(dbPath) && identity.mismatch) {
    throw new Error(
      `Workspace identity mismatch for '${publicWorkspaceName(targetName)}'.\n` +
      `  recorded sources: ${JSON.stringify(identity.recorded.sourceDirs || [])}\n` +
      `  current sources : ${JSON.stringify(identity.expected.sourceDirs)}\n` +
      `Move the existing database aside or restore the previous sourceDir before building.`
    );
  }
  if (fs.existsSync(dbPath) && !identity.recorded) {
    console.warn(`[identity] Existing '${publicWorkspaceName(targetName)}' database has no workspace marker; this successful build will adopt it.`);
  }

  // Publish that a build is running, so anything else looking at this graph can
  // tell "half a graph, still being written" from "a broken graph". A full build
  // deletes the code nodes before it rebuilds them, so an observer that arrives
  // in the middle sees a plausible-looking but incomplete result with nothing to
  // indicate why. The marker carries the pid, so a stale one (build crashed or
  // was killed) is recognisable rather than misleading.
  writeBuildMarker({ workspace: targetName, mode: isDiffMode ? 'diff' : 'full' });

  // Optional verticals are resolved once, before any query is compiled, so the
  // whole build agrees on what is active — and says so, because "why does my
  // graph have no topics" must be answerable from the build log.
  const extractors = resolveExtractors(config, targetName);
  reportExtractors(extractors);
  const extensions = Object.keys(LANG_CONFIGS);

  console.log(`Starting graph builder for '${publicWorkspaceName(targetName)}' in ${isDiffMode ? 'DIFF' : 'FULL'} mode...`);

  await Parser.init();
  const parser = new Parser();
  const langCache = {};

  const driver = ladybug.driver(dbUri, ladybug.auth.basic(auth.user, auth.pass));

  // Bring the schema up to date BEFORE writing anything.
  //
  // The daemon adds tables and columns the schema has grown, but only when it
  // opens a database — and it is a background process that happily outlives an
  // upgrade. Without this, pulling a version that stores a new node property and
  // then building against the still-running daemon fails with "Binder exception:
  // Cannot find property X" — partway in, after full mode has already emptied
  // the graph, which is the worst possible moment. Doing it here means the
  // upgrade heals itself instead of every user needing to know they must restart
  // the daemon first.
  //
  // Additive and idempotent, so it costs nothing when there is nothing to do,
  // and it never throws: an older daemon simply does not have the route.
  if (typeof ladybug.reconcileDaemonSchema === 'function') {
    const dbKey = normalizeWorkspaceName(targetName);
    if (await ladybug.reconcileDaemonSchema(dbKey)) {
      console.log(`[schema] reconciled '${publicWorkspaceName(dbKey)}' against the running daemon.`);
    }
  }

  const session = driver.session();

  let recoveryRestored = false;
  try {
    const searchDirs = Array.isArray(sourceDir) ? sourceDir : [sourceDir];
    const { files: allFiles, sourceErrors, testDirs } = collectSourceFiles(baseDir, sourceDir, { exclude, extensions });
    if (sourceErrors.length) {
      throw new Error('Source scan incomplete; graph rebuild cancelled before changing code nodes:\n'
        + sourceErrors.map(error => `  ${error.path}: ${error.code}`).join('\n'));
    }
    for (const { dir, count } of testDirs) {
      console.log(`[config] '${dir}' is a test directory and was listed explicitly, including its ${count} file(s).`);
    }

    if (allFiles.length === 0) {
      if (config.knowledge?.paths?.length) {
        await syncKnowledgeMarkdown(session, baseDir, config);
        paths.writeWorkspaceIdentity(config, targetName);
        console.log('No source files found; Markdown Knowledge was synchronized.');
        return;
      }
      console.error(
        `\nNo source files found for workspace '${targetName}'.\n` +
        `  project root : ${baseDir}\n` +
        `  sourceDir    : ${JSON.stringify(searchDirs)}\n` +
        `  extensions   : ${extensions.join(', ')}\n` +
        `\nCheck that you are running from the right project and that sourceDir in\n` +
        `codevis.config.cjs points at directories that exist on THIS machine.\n`
      );
      // Do not process.exit() here: the build marker was already written, and
      // a hard exit bypasses the session/driver cleanup and clearBuildMarker()
      // in finally below. Preserve the failing CLI status while unwinding the
      // normal cleanup path.
      process.exitCode = 1;
      return;
    }

    // Parsing is the slow part and the cost is roughly linear in file count, so a
    // sourceDir of ["."] over a large tree turns a build into a very long wait
    // with no indication that the scope is wrong rather than the machine slow.
    const LARGE_BUILD = parseInt(process.env.CODEVIS_LARGE_BUILD || '2000', 10);
    if (allFiles.length > LARGE_BUILD) {
      console.warn(
        `\nWarning: ${allFiles.length} files matched — this build will take a while.\n` +
        `  sourceDir: ${JSON.stringify(searchDirs)}\n` +
        `If that is wider than intended, narrow sourceDir in codevis.config.cjs to the\n` +
        `directories you actually want in the graph.\n`
      );
    }

    const allRelativePaths = new Set(allFiles.map(f => relGraphPath(baseDir, f)));

    if (isDiffMode) {
      const changedFiles = await getMtimeChangedFiles(session, allFiles, baseDir);
      const deletedPaths = await getDeletedFilePaths(session, allRelativePaths);

      if (changedFiles.length === 0 && deletedPaths.length === 0) {
        await syncKnowledgeMarkdown(session, baseDir, config);
        paths.writeWorkspaceIdentity(config, targetName);
        console.log('Smart mode: all files are up-to-date. Nothing to do.');
        return;
      }

      console.log(`Smart mode: ${changedFiles.length} changed / new file(s) detected.`);
      for (const f of changedFiles) console.log('  ~', relGraphPath(baseDir, f));

      const availableFilesByPath = new Map(allFiles.map(file => [relGraphPath(baseDir, file), file]));
      const changedPaths = changedFiles.map(file => relGraphPath(baseDir, file));
      // Deleted paths still exist in the old graph at this point. Include them
      // before deletion so their importers/callers are invalidated and rebuilt;
      // this is what makes a move/rename a delta operation instead of a full build.
      const invalidatedPaths = [...new Set([...changedPaths, ...deletedPaths])];
      const dependentFiles = await getDirectDependentFiles(session, invalidatedPaths, availableFilesByPath);
      const rebuildFiles = [...changedFiles, ...dependentFiles];
      console.log(`Smart mode: ${dependentFiles.length} additional direct dependent file(s) will be reparsed.`);
      for (const f of dependentFiles) console.log('  +', relGraphPath(baseDir, f));

      const rebuildPaths = rebuildFiles.map(file => relGraphPath(baseDir, file));
      // Persist the complete deletion set before the first destructive query.
      // A finally block alone cannot recover links if parsing never recreates
      // their targets or the process is terminated.
      const removedPaths = [...new Set([...deletedPaths, ...rebuildPaths])];
      const diffBackup = writeJournal(journalPath, identity.expected.fingerprint,
        await backupFileLinks(session, removedPaths));
      for (const deletedPath of deletedPaths) {
        console.log(`Smart mode: file deleted from disk, removing nodes for: ${deletedPath}`);
      }
      for (const relativePath of rebuildPaths) {
        console.log(`Removing stale nodes for: ${relativePath}`);
      }
      // One set-based sweep is substantially cheaper than scanning the entire
      // node table once for each changed/dependent file.
      await removeFileDerivedNodes(session, removedPaths);

      // Parse + restore locks in try/finally — locks must be restored even if parsing fails
      try {
        const { deferredRenders, deferredPropsMap } =
          await parseFiles(session, rebuildFiles, baseDir, allRelativePaths, langCache, parser, extractors.enabled);

        await insertDeferredEdges(session, deferredRenders, deferredPropsMap);
        await resolveGlobalCalls(session);
        await removeOrphanedSharedDerivedNodes(session);
        await assignMissingNodeIds(session);
        await assignIpv6Addresses(session, PROJECT_IDS[normalizeWorkspaceName(targetName)] || 1);

        // Stamp updated nodes with timestamp
        const parseTimestamp = Date.now();
        for (const cp of rebuildPaths) {
          await session.run(
            `MATCH (f:File {path: $path}) SET f.updatedAt = $ts
             WITH f
             OPTIONAL MATCH (f)-[:CONTAINS*]->(child)
             SET child.updatedAt = $ts`,
            { path: cp, ts: parseTimestamp }
          );
        }
        const updResult = await session.run(
          'MATCH (n) WHERE n.updatedAt = $ts RETURN count(n) AS total',
          { ts: parseTimestamp }
        );
        const updTotal = updResult.records[0].get('total').toNumber();
        console.log(`Smart mode: stamped ${updTotal} node(s) with updatedAt=${new Date(parseTimestamp).toISOString()}`);
      } finally {
        // ── Restore locks + AFFECTS edges for changed files (even on parse failure) ──
        const restored = await restoreLocksAndAffects(session, diffBackup);
        recoveryRestored = restored.lockRestored === diffBackup.locks.length
          && restored.edgesRestored === diffBackup.affects.length
          && restored.touchedRestored === diffBackup.touched.length
          && restored.knowledgeRestored === diffBackup.knowledge.length
          && restored.annotationsRestored === diffBackup.annotations.length;
      }

    } else {
      console.log('Full mode: clearing database...');

      // ── Save lock state + AFFECTS edges before clearing ──
      const fullBackup = writeJournal(journalPath, identity.expected.fingerprint,
        await backupLocksAndAffects(session));

      await session.run(
        'MATCH (n) WHERE ' +
        PRESERVED_LABELS.map(l => `NOT n:${l}`).join(' AND ') +
        ' DETACH DELETE n'
      );
      console.log(`Found ${allFiles.length} files to parse.`);

      const { deferredRenders, deferredPropsMap } =
        await parseFiles(session, allFiles, baseDir, allRelativePaths, langCache, parser, extractors.enabled);

      await insertDeferredEdges(session, deferredRenders, deferredPropsMap);
      await resolveGlobalCalls(session);
      await removeOrphanedSharedDerivedNodes(session);
      await assignMissingNodeIds(session);
      await assignIpv6Addresses(session, PROJECT_IDS[normalizeWorkspaceName(targetName)] || 1);

      // ── Restore lock state + AFFECTS edges ──
      const restored = await restoreLocksAndAffects(session, fullBackup);
      recoveryRestored = restored.lockRestored === fullBackup.locks.length
        && restored.edgesRestored === fullBackup.affects.length
        && restored.touchedRestored === fullBackup.touched.length
        && restored.knowledgeRestored === fullBackup.knowledge.length
        && restored.annotationsRestored === fullBackup.annotations.length;
    }

    // ── Re-draw spec→code REALIZED_BY edges ──
    // Spec nodes survive the wipe, the code nodes they point at do not. Where
    // the code is unchanged its uid is unchanged too, so the binding comes
    // back; where it was renamed or moved, it deliberately does not.
    // Markdown files are authoritative for document-backed Knowledge and its
    // outgoing links. At this point path#symbol targets see the finished code.
    await syncKnowledgeMarkdown(session, baseDir, config);
    await relinkRealizations(session);
    await relinkAnnotations(session);

    // ── seq eindeutig machen ──
    // Nicht kosmetisch: `seq` ist die Zahl, auf die Ladybug `id(n)` abbildet.
    // Die AST-Knoten oben entstehen in UNWIND-Blöcken zu je 500, und der
    // $__seq-Sentinel darin wird EINMAL PRO QUERY aufgelöst — alle 500 Knoten
    // eines Blocks tragen danach denselben Wert. Gemessen: 47 139 Knoten auf
    // 10 730 seq. Wer darüber adressiert, faltet 500 Knoten zu einem.
    //
    // Die Reparatur läuft hier statt an der Schreibstelle, weil sie dort einen
    // Eingriff in die Sentinel-Auflösung des Daemons bräuchte; über die uid
    // lässt sich am Ende jeder Knoten einzeln nummerieren, und das kostet auf
    // dieser Datenbank 13 Sekunden.
    await repairSeq(session);

    // Last, so it counts the finished graph — including the spec→code edges
    // that were only just drawn.
    await stampNodeDegrees(session);

    paths.writeWorkspaceIdentity(config, targetName);
    // The journal remains recoverable across exceptions and process termination.
    // Only a completed build may discard it.
    if (fs.existsSync(journalPath)) {
      if (recoveryRestored) fs.unlinkSync(journalPath);
      else console.warn(`[recovery] Some authored targets are unresolved; recovery journal retained at ${journalPath}`);
    }
    console.log('Graph builder finished successfully.');
  } catch (error) {
    console.error('Error building graph:', error);
    // Logging alone still exits with status 0. That makes CI, hooks and coding
    // agents treat a failed parse/write as a successful graph refresh.
    process.exitCode = 1;
  } finally {
    await session.close();
    await driver.close();
    clearBuildMarker();
  }
}

// ============================================================
// BUILD MARKER — "a build is running on this graph right now"
// ============================================================

const BUILD_MARKER = path.join(paths.DATA_DIR, '.build-in-progress');

function writeBuildMarker(info) {
  const payload = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    ...info,
  });
  try {
    fs.mkdirSync(path.dirname(BUILD_MARKER), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = fs.openSync(BUILD_MARKER, 'wx');
        try { fs.writeFileSync(fd, payload, 'utf8'); } finally { fs.closeSync(fd); }
        return;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
        let owner = null;
        try { owner = JSON.parse(fs.readFileSync(BUILD_MARKER, 'utf8')); } catch (_) {}
        let alive = false;
        try { process.kill(owner?.pid, 0); alive = true; } catch (probe) { alive = probe.code === 'EPERM'; }
        if (alive) throw new Error(`Another CodeVis build is already running (pid ${owner.pid}, ${owner.workspace || 'unknown workspace'}).`);
        try { fs.unlinkSync(BUILD_MARKER); } catch (_) {}
      }
    }
    throw new Error('Could not acquire the project-wide CodeVis build lock.');
  } catch (e) {
    throw e;
  }
}

function clearBuildMarker() {
  try {
    // Only remove our own marker: a second build that started meanwhile owns it,
    // and deleting it would claim that build had finished.
    const raw = JSON.parse(fs.readFileSync(BUILD_MARKER, 'utf8'));
    if (raw.pid === process.pid) fs.unlinkSync(BUILD_MARKER);
  } catch (_) { /* never existed, already gone, or someone else's */ }
}

// Run only when invoked as a script — tests require() the helpers below
// without kicking off a build.
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
    // Parser/driver setup happens before main's session try/finally. If it
    // fails there, remove the marker as well instead of advertising a dead
    // build forever.
    clearBuildMarker();
  });
}

module.exports = {
  PRESERVED_LABELS,
  toGraphPath,
  relGraphPath,
  uidToHex16,
  hex4,
  makeIpv6,
  resolveImportPath,
  // Exposed for tests that compile the tree-sitter queries against the real
  // grammars. This is not optional nicety: `safeQuery` swallows a malformed
  // query and returns null, so a query with a wrong node type produces no
  // matches and no error — the extractor just quietly does nothing. Only
  // compiling and running them against real code catches that.
  __testing__: {
    getMtimeChangedFiles,
    backupFileLinks,
    getDirectDependentFiles,
    getDeletedFilePaths,
    removeFileDerivedNodes,
    removeOrphanedSharedDerivedNodes,
    SHARED_DERIVED_OWNERSHIP,
    backupLocksAndAffects,
    restoreLocksAndAffects,
    LANG_CONFIGS,
    EXTRACTOR_CAPABILITIES,
    EXTRACTOR_REGISTRY,
    resolveImportPath,
    resolveGrammarWasm,
    safeQuery,
    // The ROS extractors are driven directly by tests/ros-extract.test.js against
    // a recording stub session, so the queries are proven against real grammars
    // rather than trusted because they look right.
    extractClasses,
    extractFunctions,
    // Fuer tests/return-values.test.js: Rueckgabe-Ausdrucke liefen frueher als
    // :Variable und verschmutzten damit jede Variablen-Abfrage. Ohne diesen
    // Export laesst sich nicht pruefen, dass sie ein eigenes Label bekommen.
    extractReturns,
    extractStates,
    extractEffects,
    extractReactWrappers,
    extractRosNodes,
    extractRosInterfaces,
    findEnclosingClass,
    positionalArgs,
    findFiles,
    // Fuer tests/ignored-dirs.test.js: die Liste muss pruefbar sein, sonst
    // faellt ein Eintrag mit Schraegstrich erst auf, wenn er nicht greift.
    IGNORED_DIRS,
    globToRegExp,
    compileExcludeMatchers,
    selectUnambiguousCallbackTarget,
    kotlinFunctionSemantics,
    pythonFunctionSemantics,
    jsTsFunctionSemantics,
    countParameters,
    kotlinReceiverTypes,
    jsTsReceiverTypes,
    cppReceiverTypes,
    pythonScopedAliases,
    selectClassCandidate,
    extractClassInheritance,
    // Ohne diesen Export war nicht prüfbar, dass eine @property im Diagramm
    // als Attribut erscheint: der Testharness hätte die Dekoratoren nie
    // geschrieben und das Modell nie welche gesehen.
    extractDecorators,
    extractInstantiations,
    extractCalls,
    extractCallbacks,
    extractPythonAttributeTypes,
    simplePythonTypeName,
    // The attribute compartment of a class box is fed by this one — Python has
    // no declaration site for fields, so `self.x = …` and the bare annotations
    // in a class body ARE the field list. Without it in reach, a test can only
    // check that a class box exists, never that it has any content.
    extractAllVariables,
    linkOutOfLineMethods,
    invalidateClassResolution,
    resolveFunctionNode,
    hasFunctionAncestorBeforeClass,
    formatProgressBar,
    summarizeExtensions,
  },
};
