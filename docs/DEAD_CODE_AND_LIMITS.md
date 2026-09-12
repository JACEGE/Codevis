# Dead code and analysis limits

CodeVis reports **potential dead-code candidates**. It does not claim that an
unreferenced node is safe to delete.

## What the scan establishes

The builder extracts declarations and static relationships for supported
languages. A Function, Class or File with no incoming structural edge can be
shown as isolated or returned by a predefined query. This is useful for finding
old helpers, duplicates and disconnected modules.

## What static parsing can miss

- reflection and string-based lookup;
- dependency injection and framework registration;
- callbacks stored in data structures;
- dynamic imports, re-exports and namespace calls;
- CLI, test-runner, plugin and serialization entry points;
- generated code and files outside configured `sourceDir`;
- calls made by another process or language;
- HTML/CSS references, which currently have no full call model.
- shell commands assembled dynamically, sourced through computed paths or
  invoked indirectly; Bash files and statically named functions/source imports
  are parsed, but shell runtime behavior remains highly dynamic.

For Kotlin/Android, CodeVis lowers false positives by marking common lifecycle
overrides, callbacks and manifest components as framework entry points. The
`dead_code` predefined query reports those as `framework_callback` with low
confidence, public uncalled functions as `public_no_static_caller`, and only the
remaining functions as ordinary `no_static_caller` candidates. These categories
improve triage; they are still not runtime reachability proofs.

Thus “zero incoming edges” means “no supported static relationship was found”,
not “unused at runtime”. Confirm with repository search, tests and runtime data.
