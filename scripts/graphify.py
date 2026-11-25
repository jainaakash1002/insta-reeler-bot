#!/usr/bin/env python3
"""
graphify: a code graph of this repo (src/*.js and the yt-dlp plugin), written to graphify-out/.

    python3 scripts/graphify.py            # writes graphify-out/{GRAPH_REPORT.md,graph.json,manifest.json,graph.html}

Python 3.9+, standard library only. The output is deterministic: the same code gives
byte-identical files, so a diff in graphify-out/ means the code structure moved.

What it extracts (with a small lexer and regexes, not a real parser):
- nodes: files, top-level functions / generators / classes / consts, the bot's Telegram
  handlers (bot.command('clip'), bot.on('message:text'), bot.callbackQuery(...)), packages;
- edges: declares (file -> symbol), imports (file -> imported symbol), depends_on
  (file -> file or package), calls (symbol -> symbol it calls), uses (symbol -> a top-level
  name it reads without calling, e.g. a constant or a function passed as a value), re_exports.
Calls resolve to symbols declared in the same file or imported by name (EXTRACTED); a call to
a name declared in exactly one other file that isn't imported is INFERRED (0.8).
Communities follow the code's own structure: one per module, and files over SPLIT_LINES lines
(bot.js) are split by their "// ---------- name ----------" section headers. Packages join the
community that imports them most. Names are curated in graphify-out/.graphify_labels.json
(read-only input, keyed by "<file>#<section>"); missing ones are printed and auto-named.
"""

import hashlib
import json
import os
import re
import sys
from collections import Counter, defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOTS = ["src", "yt-dlp-plugins"]
CODE_EXT = (".js", ".mjs", ".py")
SKIP_DIRS = {"node_modules", "__pycache__", ".git"}
OUT_DIR = os.path.join(REPO, "graphify-out")
SCOPE = " + ".join(ROOTS)

JS_KEYWORDS = {
    "if", "for", "while", "switch", "catch", "return", "function", "typeof", "new", "await", "async",
    "import", "export", "const", "let", "var", "throw", "delete", "void", "in", "of", "instanceof",
    "super", "this", "class", "else", "do", "try", "finally", "yield", "case", "default",
}
PY_KEYWORDS = {"if", "for", "while", "return", "def", "class", "with", "not", "and", "or", "in", "is", "lambda", "yield", "print", "super"}

# ---------------------------------------------------------------------------
# lexing: blank comments and string contents (keeping ${...} in templates), so braces and
# names inside them don't count. Offsets and line numbers stay the same.
# ---------------------------------------------------------------------------

REGEX_BEFORE = set("(,=:[!&|?{};+-*%<>~^")


def blank_js(text):
    out = list(text)
    i, n = 0, len(text)
    templates = []  # brace depth at which each open template's ${ started
    depth = 0
    last = ""  # last significant code character

    def blank(a, b):
        for k in range(a, b):
            if out[k] != "\n":
                out[k] = " "

    while i < n:
        c = text[i]
        if templates and c == "}" and depth == templates[-1]:
            templates.pop()
            depth -= 1
            i = scan_template(text, i + 1, blank, templates, lambda: depth)
            last = "`"
            continue
        if c == "/" and text.startswith("//", i):
            j = text.find("\n", i)
            j = n if j < 0 else j
            blank(i, j)
            i = j
            continue
        if c == "/" and text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2
            blank(i, j)
            i = j
            continue
        if c in "'\"":
            j = i + 1
            while j < n and text[j] != c and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            blank(i + 1, min(j, n))
            i, last = j + 1, c
            continue
        if c == "`":
            i = scan_template(text, i + 1, blank, templates, lambda: depth)
            last = "`"
            continue
        if c == "/" and (last in REGEX_BEFORE or last == "" or re.search(r"\b(return|typeof|case)\s*$", text[max(0, i - 8):i])):
            j, in_class = i + 1, False
            while j < n and text[j] != "\n":
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == "[":
                    in_class = True
                elif text[j] == "]":
                    in_class = False
                elif text[j] == "/" and not in_class:
                    break
                j += 1
            blank(i + 1, min(j, n))
            i, last = j + 1, "/"
            continue
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        if not c.isspace():
            last = c
        i += 1
    return "".join(out)


def scan_template(text, i, blank, templates, depth_now):
    """Blanks a template literal's text from i; stops after the closing ` or at a ${ (pushed on `templates`)."""
    n = len(text)
    start = i
    while i < n:
        if text[i] == "\\":
            i += 2
            continue
        if text[i] == "`":
            blank(start, i)
            return i + 1
        if text.startswith("${", i):
            blank(start, i)
            templates.append(depth_now() + 1)  # the { of ${ is counted by the main loop
            return i + 1
        i += 1
    blank(start, n)
    return n


def blank_py(text):
    out = list(text)

    def blank(a, b):
        for k in range(a, b):
            if out[k] != "\n":
                out[k] = " "

    for m in re.finditer(r'(?s)("""|\'\'\').*?\1|#[^\n]*|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'', text):
        blank(m.start() + (0 if m.group(0).startswith("#") else 1), m.end() - (0 if m.group(0).startswith("#") else 1))
    return "".join(out)


def line_of(text, index):
    return text.count("\n", 0, index) + 1


def depth_map(clean):
    """Brace depth before each character (JS)."""
    depths, d = [], 0
    for c in clean:
        depths.append(d)
        if c in "{([":
            d += 1
        elif c in "})]":
            d -= 1
    return depths


# ---------------------------------------------------------------------------
# extraction
# ---------------------------------------------------------------------------

JS_DECL = re.compile(
    r"^(?P<export>export\s+(?:default\s+)?)?(?:"
    r"(?P<async>async\s+)?function\s*(?P<gen>\*)?\s*(?P<fn>[A-Za-z_$][\w$]*)"
    r"|class\s+(?P<cls>[A-Za-z_$][\w$]*)"
    r"|(?:const|let|var)\s+(?P<var>[A-Za-z_$][\w$]*)\s*=\s*(?P<rhs>[^\n]{0,80})"
    r")",
    re.M,
)
JS_HANDLER = re.compile(r"^bot\.(?P<kind>command|on|callbackQuery|catch)\s*\(\s*(?P<arg>[^,\n]*?)\s*(?:,|\))", re.M)
JS_IMPORT = re.compile(r"^import\s+(?P<clause>[^;]*?)\s+from\s+['\"](?P<src>[^'\"]+)['\"]", re.M)
JS_REEXPORT = re.compile(r"^export\s+(?:\*|\{[^}]*\})\s+from\s+['\"](?P<src>[^'\"]+)['\"]", re.M)
PY_DECL = re.compile(r"^(?P<indent>[ \t]*)(?:(?P<def>def)\s+(?P<fn>\w+)|class\s+(?P<cls>\w+))", re.M)
PY_IMPORT = re.compile(r"^(?:from\s+(?P<mod>[\w.]+)\s+import\s+(?P<names>[^\n]+)|import\s+(?P<plain>[\w.]+))", re.M)
CALL = re.compile(r"(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(")
NAME_REF = re.compile(r"(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$]|\s*\(|\s*:(?!:))")


def slug(text):
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def file_id(rel):
    return slug(rel)


def symbol_id(rel, name):
    return slug(os.path.splitext(rel)[0]) + "_" + slug(name)


def handler_label(kind, arg):
    arg = re.sub(r"\s+", " ", arg.strip())
    return "bot.%s(%s)" % (kind, arg) if arg else "bot.%s()" % kind


def extract_js(rel, raw):
    """Returns (declarations, imports, reexports). A declaration: dict(name, kind, line, start, end, label, exported)."""
    clean = blank_js(raw)
    depths = depth_map(clean)
    starts = []
    for m in JS_DECL.finditer(clean):
        if depths[m.start()] != 0:
            continue
        if m.group("fn"):
            name, kind = m.group("fn"), "generator" if m.group("gen") else "function"
        elif m.group("cls"):
            name, kind = m.group("cls"), "class"
        else:
            name, rhs = m.group("var"), m.group("rhs") or ""
            kind = "function" if re.match(r"(async\s+)?(\([^)]*\)|[\w$]+)\s*=>|(async\s+)?function\b", rhs) else "const"
        label = name + "()" if kind in ("function", "generator") else name
        starts.append(dict(name=name, kind=kind, start=m.start(), line=line_of(raw, m.start()), label=label, exported=bool(m.group("export"))))
    for m in JS_HANDLER.finditer(clean):
        if depths[m.start()] != 0:
            continue
        # The handler's first argument (a string, an array of strings or a constant), read from the
        # raw text because strings are blanked in `clean`; bot.catch has none.
        raw_arg = ""
        if m.group("kind") != "catch":
            after = raw[m.end("kind"):]
            arg = re.match(r"\s*\(\s*(\[[^\]]*\]|'[^']*'|\"[^\"]*\"|[\w.$]+)", after)
            raw_arg = arg.group(1) if arg else ""
        label = handler_label(m.group("kind"), raw_arg)
        starts.append(dict(name=label, kind="handler", start=m.start(), line=line_of(raw, m.start()), label=label, exported=False))
    # Each top-level statement runs until the next one starts at depth 0.
    boundaries = sorted(set([d["start"] for d in starts] + [m.start() for m in re.finditer(r"^\S", clean, re.M) if depths[m.start()] == 0]))
    for d in starts:
        later = [b for b in boundaries if b > d["start"]]
        d["end"] = later[0] if later else len(clean)
    imports = []
    for m in JS_IMPORT.finditer(clean):
        clause = raw[m.start("clause"):m.end("clause")]
        names = []
        default = re.match(r"\s*([A-Za-z_$][\w$]*)\s*(?:,|$)", clause)
        if default:
            names.append((default.group(1), "default"))
        brace = re.search(r"\{([^}]*)\}", clause)
        if brace:
            for part in brace.group(1).split(","):
                part = part.strip()
                if not part:
                    continue
                pieces = re.split(r"\s+as\s+", part)
                names.append((pieces[-1].strip(), pieces[0].strip()))
        src = raw[m.start("src"):m.end("src")]
        imports.append(dict(src=src, names=names, line=line_of(raw, m.start())))
    reexports = [dict(src=raw[m.start("src"):m.end("src")], line=line_of(raw, m.start())) for m in JS_REEXPORT.finditer(clean)]
    return starts, imports, reexports, clean


def extract_py(rel, raw):
    clean = blank_py(raw)
    starts = []
    for m in PY_DECL.finditer(clean):
        if m.group("indent"):
            continue  # top level only (methods belong to their class)
        if m.group("def"):
            name, kind, label = m.group("fn"), "function", m.group("fn") + "()"
        else:
            name, kind, label = m.group("cls"), "class", m.group("cls")
        starts.append(dict(name=name, kind=kind, start=m.start(), line=line_of(raw, m.start()), label=label, exported=True))
    top = [m.start() for m in re.finditer(r"^\S", clean, re.M)]
    for d in starts:
        later = [b for b in top if b > d["start"]]
        d["end"] = later[0] if later else len(clean)
    imports = []
    for m in PY_IMPORT.finditer(clean):
        if m.group("mod"):
            names = [(p.strip().split(" as ")[-1].strip(), p.strip().split(" as ")[0].strip()) for p in m.group("names").strip("() ").split(",") if p.strip()]
            imports.append(dict(src=m.group("mod"), names=names, line=line_of(raw, m.start())))
        else:
            imports.append(dict(src=m.group("plain"), names=[], line=line_of(raw, m.start())))
    return starts, imports, [], clean


# ---------------------------------------------------------------------------
# collection
# ---------------------------------------------------------------------------


def collect_files():
    files = []
    for root in ROOTS:
        for dirpath, dirnames, filenames in os.walk(os.path.join(REPO, root)):
            dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS)
            for name in sorted(filenames):
                if name.endswith(CODE_EXT):
                    files.append(os.path.relpath(os.path.join(dirpath, name), REPO))
    return sorted(files)


def resolve_import(src, from_rel, known):
    if not src.startswith("."):
        return None
    base = os.path.normpath(os.path.join(os.path.dirname(from_rel), src))
    for candidate in (base, base + ".js", base + ".mjs", os.path.join(base, "index.js")):
        if candidate in known:
            return candidate
    return None


def package_of(src):
    if src.startswith("node:"):
        return src
    parts = src.split("/")
    return "/".join(parts[:2]) if src.startswith("@") else parts[0].split(".")[0]


# ---------------------------------------------------------------------------
# communities: modules, and sections of big files
# ---------------------------------------------------------------------------

SPLIT_LINES = 600
SECTION_RE = re.compile(r"^(?://|#) -{6,} (?P<name>.+?) -{6,}\s*$", re.M)


def sections_of(rel, raw):
    """[(offset, community key)] for a file: one section, or its headers when it is big."""
    whole = [(0, "%s#%s" % (rel, os.path.basename(rel)))]
    if raw.count("\n") < SPLIT_LINES:
        return whole
    headers = [(m.start(), "%s#%s" % (rel, m.group("name"))) for m in SECTION_RE.finditer(raw)]
    if not headers:
        return whole
    # What comes before the first header (imports) belongs to the first section.
    return [(0, headers[0][1])] + headers[1:]


def section_at(sections, offset):
    key = sections[0][1]
    for start, name in sections:
        if start <= offset:
            key = name
    return key


def cohesion(members, edges):
    member_set = set(members)
    pairs = set()
    for e in edges:
        if e["source"] in member_set and e["target"] in member_set and e["source"] != e["target"]:
            pairs.add(tuple(sorted((e["source"], e["target"]))))
    n = len(members)
    return round(len(pairs) / (n * (n - 1) / 2), 2) if n > 1 else 0.0


# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------


def build():
    files = collect_files()
    known = set(files)
    nodes, edges = {}, []
    texts, decls_by_file, clean_by_file, imports_by_file = {}, {}, {}, {}
    community_key = {}  # node id -> "<file>#<section>"
    total_words = 0

    def add_node(nid, label, rel, line, kind):
        if nid not in nodes:
            nodes[nid] = dict(id=nid, label=label, file_type="code", source_file=rel, source_location="L%d" % line, node_kind=kind, norm_label=label)
        return nid

    def add_edge(src, dst, relation, context, rel, line, confidence="EXTRACTED", score=1.0):
        edges.append(dict(relation=relation, context=context, confidence=confidence, source_file=rel, source_location="L%d" % line, weight=1.0, source=src, target=dst, confidence_score=score))

    for rel in files:
        with open(os.path.join(REPO, rel), encoding="utf-8") as fh:
            raw = fh.read()
        texts[rel] = raw
        total_words += len(raw.split())
        fid = add_node(file_id(rel), os.path.basename(rel), rel, 1, "file")
        decls, imports, reexports, clean = (extract_py if rel.endswith(".py") else extract_js)(rel, raw)
        decls_by_file[rel], clean_by_file[rel], imports_by_file[rel] = decls, clean, imports
        sections = sections_of(rel, raw)
        community_key[fid] = sections[0][1]
        for d in decls:
            sid = add_node(symbol_id(rel, d["name"]), d["label"], rel, d["line"], d["kind"])
            community_key[sid] = section_at(sections, d["start"])
            add_edge(fid, sid, "declares", d["kind"], rel, d["line"])

    by_name = defaultdict(list)  # exported/top-level name -> [(file, node id)]
    for rel, decls in decls_by_file.items():
        for d in decls:
            if d["kind"] != "handler":
                by_name[d["name"]].append((rel, symbol_id(rel, d["name"])))

    for rel in files:
        fid = file_id(rel)
        local = {d["name"]: symbol_id(rel, d["name"]) for d in decls_by_file[rel] if d["kind"] != "handler"}
        imported = {}
        for imp in imports_by_file[rel]:
            target = resolve_import(imp["src"], rel, known)
            if target:
                add_edge(fid, file_id(target), "depends_on", "import", rel, imp["line"])
                for alias, original in imp["names"]:
                    tid = symbol_id(target, original)
                    if tid in nodes:
                        imported[alias] = tid
                        add_edge(fid, tid, "imports", "named", rel, imp["line"])
            else:
                pkg = package_of(imp["src"])
                pid = add_node("pkg_" + slug(pkg), pkg, "", 0, "package")
                nodes[pid]["file_type"] = "package"
                nodes[pid]["source_file"] = None
                nodes[pid]["source_location"] = None
                add_edge(fid, pid, "depends_on", "import", rel, imp["line"])
        # calls, per declaration body
        raw, clean = texts[rel], clean_by_file[rel]
        keywords = PY_KEYWORDS if rel.endswith(".py") else JS_KEYWORDS
        for d in decls_by_file[rel]:
            sid = symbol_id(rel, d["name"])
            body = clean[d["start"]:d["end"]]
            seen = set()
            for m in CALL.finditer(body):
                name = m.group(1)
                if name in keywords or name == d["name"] or name in seen:
                    continue
                line = line_of(raw, d["start"] + m.start())
                if name in local:
                    target, conf, score = local[name], "EXTRACTED", 1.0
                elif name in imported:
                    target, conf, score = imported[name], "EXTRACTED", 1.0
                else:
                    others = [t for f, t in by_name.get(name, []) if f != rel]
                    if len(others) != 1:
                        continue
                    target, conf, score = others[0], "INFERRED", 0.8
                seen.add(name)
                add_edge(sid, target, "calls", "call", rel, line, conf, score)
            # names read without a call: constants, and functions passed as values
            for m in NAME_REF.finditer(body):
                name = m.group(1)
                if name in seen or name == d["name"] or name in keywords:
                    continue
                target = local.get(name) or imported.get(name)
                if not target:
                    continue
                seen.add(name)
                add_edge(sid, target, "uses", "reference", rel, line_of(raw, d["start"] + m.start()))
        # Telegram handlers also "call" the module-level names they use without parentheses
        # (e.g. SCREENSHOT_DATA): skipped on purpose; consts used in calls show up via the call.

    # re-exports (none today; kept for completeness)
    for rel in files:
        if rel.endswith(".py"):
            continue
        for rx in extract_js(rel, texts[rel])[2]:
            target = resolve_import(rx["src"], rel, known)
            if target:
                add_edge(file_id(rel), file_id(target), "re_exports", "export", rel, rx["line"])

    # dedupe edges (same source, target, relation): keep the first
    unique, seen = [], set()
    for e in edges:
        key = (e["source"], e["target"], e["relation"])
        if key not in seen:
            seen.add(key)
            unique.append(e)
    edges = unique

    # packages join the community of the files that import them most
    for nid, v in nodes.items():
        if v["node_kind"] == "package":
            votes = Counter(community_key[e["source"]] for e in edges if e["target"] == nid and e["source"] in community_key)
            community_key[nid] = sorted(votes.items(), key=lambda kv: (-kv[1], kv[0]))[0][0]
    members = defaultdict(list)
    for nid, key in community_key.items():
        members[key].append(nid)
    # numbered in source order (files sorted, sections in file order), so numbers are stable
    order = []
    for rel in files:
        for _, key in sections_of(rel, texts[rel]):
            if key in members and key not in order:
                order.append(key)
    order += sorted(k for k in members if k not in order)
    number = {key: i for i, key in enumerate(order)}
    for nid in nodes:
        nodes[nid]["community"] = number[community_key[nid]]
    communities = [dict(id=number[key], anchor=key, members=sorted(members[key])) for key in order]
    return files, nodes, edges, communities, texts, total_words


def degree_map(edges):
    degree = Counter()
    for e in edges:
        degree[e["source"]] += 1
        degree[e["target"]] += 1
    return degree


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------

# Conventions from CLAUDE.md that a dependency can break.
SITE_MODULES = {"src/facebook.js", "src/reddit.js", "src/snapchat.js", "src/x.js", "src/threads.js"}
TELEGRAM_FREE = SITE_MODULES | {"src/instagram.js", "src/frames.js", "src/pdf.js"}


def layer_violations(nodes, edges):
    rows = []
    for e in edges:
        if e["relation"] != "depends_on":
            continue
        src, dst = nodes[e["source"]], nodes[e["target"]]
        rel = src["source_file"]
        if rel in TELEGRAM_FREE and (dst["label"] == "grammy" or dst.get("source_file") == "src/bot.js"):
            rows.append(("Telegram-free module -> Telegram", rel, e["source_location"], dst.get("source_file") or dst["label"]))
        if rel in SITE_MODULES and dst.get("source_file") in SITE_MODULES | {"src/instagram.js"}:
            rows.append(("site module -> another site module", rel, e["source_location"], dst["source_file"]))
        if rel in TELEGRAM_FREE and dst["label"] in ("node:child_process",) and rel not in ("src/instagram.js", "src/frames.js"):
            rows.append(("subprocess outside instagram.js/frames.js", rel, e["source_location"], dst["label"]))
    return sorted(set(rows))


def load_labels():
    path = os.path.join(OUT_DIR, ".graphify_labels.json")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    return {}


def auto_label(community, nodes):
    rel, section = community["anchor"].split("#", 1)
    base = os.path.basename(rel)
    return base if section == base else "%s: %s" % (base, section)


def name_of(community, labels, nodes):
    return labels.get(community["anchor"]) or auto_label(community, nodes)


def write_report(files, nodes, edges, communities, labels, total_words):
    degree = degree_map(edges)
    inferred = [e for e in edges if e["confidence"] == "INFERRED"]
    lines = []
    w = lines.append
    w("# Graph Report - %s" % SCOPE)
    w("")
    w("## Corpus Check")
    w("- Corpus: %d files · ~%s words. AST-free extraction, no token cost." % (len(files), format(total_words, ",")))
    w("")
    w("## Summary")
    w("- %d nodes · %d edges · %d communities detected" % (len(nodes), len(edges), len(communities)))
    pct = lambda k: round(100 * sum(1 for e in edges if e["confidence"] == k) / max(1, len(edges)))
    avg = round(sum(e["confidence_score"] for e in inferred) / len(inferred), 2) if inferred else 0
    w("- Extraction: %d%% EXTRACTED · %d%% INFERRED · 0%% AMBIGUOUS · INFERRED: %d edges (avg confidence: %s)" % (pct("EXTRACTED"), pct("INFERRED"), len(inferred), avg))
    w("- Token cost: 0 input · 0 output")
    w("")
    w("## Community Hubs (Navigation)")
    for c in communities:
        name = name_of(c, labels, nodes)
        w("- [[_COMMUNITY_%s|%s]]" % (re.sub(r"[^\w &()-]", "", name), name))
    w("")
    w("## God Nodes (most connected - your core abstractions)")
    symbols = [n for n in nodes.values() if n["node_kind"] not in ("file", "package")]
    for i, n in enumerate(sorted(symbols, key=lambda n: (-degree[n["id"]], n["id"]))[:12], 1):
        w("%d. `%s` - %d edges  (%s:%s)" % (i, n["label"], degree[n["id"]], n["source_file"], n["source_location"]))
    w("")
    w("## Hub Files (most connected modules)")
    per_file = Counter()
    for e in edges:
        for end in (e["source"], e["target"]):
            f = nodes[end]["source_file"]
            if f:
                per_file[f] += 1
    for i, (f, count) in enumerate(sorted(per_file.items(), key=lambda kv: (-kv[1], kv[0]))[:12], 1):
        w("%d. `%s` - %d edges" % (i, f, count))
    w("")
    w("## Telegram Handlers (entry points)")
    handlers = sorted((n for n in nodes.values() if n["node_kind"] == "handler"), key=lambda n: int(n["source_location"][1:]))
    for n in handlers:
        calls = sorted(nodes[e["target"]]["label"] for e in edges if e["source"] == n["id"] and e["relation"] == "calls")
        w("- `%s` (%s) -> %s" % (n["label"], n["source_location"], ", ".join("`%s`" % c for c in calls) or "(inline)"))
    w("")
    w("## External Dependencies (most imported)")
    pkg_sites = Counter()
    for e in edges:
        if nodes[e["target"]]["node_kind"] == "package":
            pkg_sites[nodes[e["target"]]["label"]] += 1
    for pkg, count in sorted(pkg_sites.items(), key=lambda kv: (-kv[1], kv[0]))[:12]:
        w("- `%s` - %d import site%s" % (pkg, count, "" if count == 1 else "s"))
    w("")
    w("## Surprising Connections (you probably didn't know these)")
    cross = [e for e in edges if e["relation"] == "calls" and nodes[e["source"]]["source_file"] != nodes[e["target"]]["source_file"]
             and nodes[e["source"]]["community"] != nodes[e["target"]]["community"]]
    pair_count = Counter((nodes[e["source"]]["community"], nodes[e["target"]]["community"]) for e in cross)
    cross.sort(key=lambda e: (e["confidence"] != "INFERRED", pair_count[(nodes[e["source"]]["community"], nodes[e["target"]]["community"])], e["source"], e["target"]))
    for e in cross[:8]:
        s, t = nodes[e["source"]], nodes[e["target"]]
        w("- `%s` --calls--> `%s`  [%s]" % (s["label"], t["label"], e["confidence"]))
        w("  %s → %s" % (s["source_file"], t["source_file"]))
    if not cross:
        w("- none")
    w("")
    w("## Layer Boundary Crossings")
    w("Edges that cross a boundary the conventions in CLAUDE.md discourage (site modules, instagram.js, frames.js and pdf.js")
    w("have no Telegram dependency; site modules don't import each other; subprocesses only in instagram.js/frames.js):")
    violations = layer_violations(nodes, edges)
    for kind, rel, loc, dst in violations:
        w("- %s: `%s` (%s) → `%s`" % (kind, rel, loc, dst))
    if not violations:
        w("- none")
    w("")
    w("## Communities")
    for c in communities:
        w("")
        w("### Community %d - \"%s\"" % (c["id"], name_of(c, labels, nodes)))
        w("Cohesion: %s" % cohesion(c["members"], edges))
        ranked = sorted(c["members"], key=lambda m: (-degree[m], m))
        shown = ", ".join(nodes[m]["label"] for m in ranked[:8])
        more = len(ranked) - 8
        w("Nodes (%d): %s%s" % (len(ranked), shown, " (+%d more)" % more if more > 0 else ""))
    w("")
    with open(os.path.join(OUT_DIR, "GRAPH_REPORT.md"), "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines))


HTML_TEMPLATE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code Graph</title>
<script src="https://unpkg.com/vis-network@9.1.9/standalone/umd/vis-network.min.js"></script>
<style>
  :root { --bg: #fbfbfa; --fg: #1f2328; --muted: #6b7280; --panel: #ffffff; --line: #e5e7eb; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111317; --fg: #e6e6e6; --muted: #9aa0a6; --panel: #1a1d23; --line: #2c313a; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.4 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg); display: flex; height: 100vh; }
  #side { width: 320px; padding: 16px; border-right: 1px solid var(--line); overflow: auto; background: var(--panel); }
  #graph { flex: 1; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .muted { color: var(--muted); font-size: 12px; }
  input { width: 100%; padding: 6px 8px; margin: 12px 0; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--fg); }
  label { display: flex; gap: 6px; align-items: center; font-size: 13px; margin: 3px 0; cursor: pointer; }
  .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  #info { margin-top: 12px; font-size: 13px; white-space: pre-wrap; word-break: break-word; }
  @media (max-width: 700px) { body { flex-direction: column; } #side { width: auto; height: 40vh; border-right: 0; border-bottom: 1px solid var(--line); } }
</style>
</head>
<body>
<div id="side">
  <h1>Code Graph</h1>
  <div class="muted">__SCOPE__ · __COUNTS__</div>
  <input id="q" placeholder="Search a function, file or handler…">
  <div id="legend"></div>
  <div id="info" class="muted">Click a node to see what it connects to.</div>
</div>
<div id="graph"></div>
<script>
const DATA = __DATA__;
const COLORS = ["#4e79a7","#f28e2b","#e15759","#76b7b2","#59a14f","#edc948","#b07aa1","#ff9da7","#9c755f","#bab0ac","#86bcb6","#d37295","#a0cbe8","#ffbe7d","#8cd17d","#b6992d","#499894","#e49444","#d4a6c8","#79706e"];
const SHAPES = { file: "box", package: "diamond", handler: "star", class: "triangle", const: "dot", function: "dot", generator: "dot" };
const color = (c) => COLORS[c % COLORS.length];
const nodes = new vis.DataSet(DATA.nodes.map((n) => ({ id: n.id, label: n.label, group: n.community, shape: SHAPES[n.node_kind] || "dot",
  size: n.node_kind === "file" ? 18 : 6 + Math.min(14, n.degree), color: color(n.community), title: `${n.label}\\n${n.source_file || "package"} ${n.source_location || ""}`,
  font: { size: n.node_kind === "file" || n.node_kind === "handler" ? 14 : 11 } })));
const edges = new vis.DataSet(DATA.links.map((e, i) => ({ id: i, from: e.source, to: e.target, arrows: e.relation === "declares" ? "" : "to",
  dashes: e.confidence === "INFERRED", color: { opacity: e.relation === "declares" ? 0.15 : 0.45 }, title: e.relation })));
const network = new vis.Network(document.getElementById("graph"), { nodes, edges }, {
  physics: { solver: "forceAtlas2Based", stabilization: { iterations: 250 } }, interaction: { hover: true }, edges: { smooth: false } });
const byId = Object.fromEntries(DATA.nodes.map((n) => [n.id, n]));
const legend = document.getElementById("legend");
const hidden = new Set();
DATA.communities.forEach((c) => {
  const row = document.createElement("label");
  row.innerHTML = `<input type="checkbox" checked style="width:auto;margin:0"><span class="dot" style="background:${color(c.id)}"></span><span></span>`;
  row.lastChild.textContent = `${c.name} (${c.size})`;
  row.firstChild.addEventListener("change", (ev) => {
    ev.target.checked ? hidden.delete(c.id) : hidden.add(c.id);
    nodes.update(DATA.nodes.map((n) => ({ id: n.id, hidden: hidden.has(n.community) })));
  });
  legend.appendChild(row);
});
network.on("click", (p) => {
  const info = document.getElementById("info");
  if (!p.nodes.length) { info.textContent = "Click a node to see what it connects to."; return; }
  const n = byId[p.nodes[0]];
  const out = DATA.links.filter((e) => e.source === n.id).map((e) => `→ ${e.relation} ${byId[e.target].label}`);
  const inc = DATA.links.filter((e) => e.target === n.id).map((e) => `← ${e.relation} ${byId[e.source].label}`);
  info.textContent = `${n.label}\\n${n.node_kind} · ${n.source_file || "package"} ${n.source_location || ""}\\ncommunity: ${DATA.communities.find((c) => c.id === n.community).name}\\n\\n${[...out, ...inc].slice(0, 60).join("\\n")}`;
});
document.getElementById("q").addEventListener("input", (ev) => {
  const q = ev.target.value.trim().toLowerCase();
  if (!q) return network.unselectAll();
  const hits = DATA.nodes.filter((n) => n.label.toLowerCase().includes(q)).map((n) => n.id);
  network.selectNodes(hits);
  if (hits.length === 1) network.focus(hits[0], { scale: 1.2, animation: true });
});
</script>
</body>
</html>
"""


def main():
    if "-h" in sys.argv or "--help" in sys.argv:
        print(__doc__)
        return
    os.makedirs(OUT_DIR, exist_ok=True)
    files, nodes, edges, communities, texts, total_words = build()
    labels = load_labels()
    degree = degree_map(edges)
    node_list = [nodes[k] for k in sorted(nodes)]
    graph = dict(
        directed=False,
        multigraph=False,
        graph=dict(scope=SCOPE, generator="scripts/graphify.py", include_tests=False),
        nodes=node_list,
        links=edges,
        hyperedges=[],
    )
    with open(os.path.join(OUT_DIR, "graph.json"), "w", encoding="utf-8") as fh:
        json.dump(graph, fh, indent=2, ensure_ascii=False)
        fh.write("\n")
    # hash + line count per file (no mtime: it changes on every checkout and would churn the diff)
    manifest = {rel: dict(hash=hashlib.md5(texts[rel].encode("utf-8")).hexdigest(), lines=texts[rel].count("\n") + 1) for rel in files}
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    write_report(files, nodes, edges, communities, labels, total_words)
    html_data = dict(
        nodes=[dict(n, degree=degree[n["id"]]) for n in node_list],
        links=[dict(source=e["source"], target=e["target"], relation=e["relation"], confidence=e["confidence"]) for e in edges],
        communities=[dict(id=c["id"], name=name_of(c, labels, nodes), size=len(c["members"])) for c in communities],
    )
    html = (HTML_TEMPLATE.replace("__SCOPE__", SCOPE)
            .replace("__COUNTS__", "%d nodes · %d edges · %d communities" % (len(nodes), len(edges), len(communities)))
            .replace("__DATA__", json.dumps(html_data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")))
    with open(os.path.join(OUT_DIR, "graph.html"), "w", encoding="utf-8") as fh:
        fh.write(html)
    missing = [c["anchor"] for c in communities if c["anchor"] not in labels]
    print("graphify-out/: %d files, %d nodes, %d edges, %d communities" % (len(files), len(nodes), len(edges), len(communities)))
    if missing:
        print("communities without a curated name in graphify-out/.graphify_labels.json:")
        for c in communities:
            if c["anchor"] in missing:
                print("  %-60s %s" % (json.dumps(c["anchor"]), auto_label(c, nodes)))


if __name__ == "__main__":
    main()
