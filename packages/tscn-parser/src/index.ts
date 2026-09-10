import type {
  GodotConnection,
  GodotDocumentKind,
  GodotEditable,
  GodotExtResource,
  GodotNode,
  GodotParseDiagnostic,
  GodotResource,
  GodotResourceRefValue,
  GodotSceneState,
  GodotSceneStateConnection,
  GodotSceneStateNode,
  GodotSectionHeader,
  GodotSubResource,
  GodotVariant,
} from "@godot-scene-web/core";

interface ParsedDocument {
  kind: GodotDocumentKind;
  header: GodotSectionHeader | null;
  extResources: GodotExtResource[];
  subResources: GodotSubResource[];
  nodes: GodotNode[];
  connections: GodotConnection[];
  editables: GodotEditable[];
  properties: Record<string, GodotVariant>;
  diagnostics: GodotParseDiagnostic[];
}

type CurrentSection =
  | { kind: "header"; header: GodotSectionHeader }
  | { kind: "ext_resource"; resource: GodotExtResource }
  | { kind: "sub_resource"; resource: GodotSubResource }
  | { kind: "node"; node: GodotNode }
  | { kind: "connection"; connection: GodotConnection }
  | { kind: "editable"; editable: GodotEditable }
  | { kind: "resource" }
  | { kind: "document" };

export interface ParseGodotTextOptions {
  path?: string;
  kind?: GodotDocumentKind;
}

export function parseGodotTextScene(
  text: string,
  options: ParseGodotTextOptions = {},
): GodotSceneState {
  return godotSceneStateFromDocument(
    parseDocument(text, { ...options, kind: "scene" }),
  );
}

export function parseGodotResource(
  text: string,
  options: ParseGodotTextOptions = {},
): GodotResource {
  return godotResourceFromDocument(
    parseDocument(text, { ...options, kind: "resource" }),
  );
}

function parseDocument(
  text: string,
  options: ParseGodotTextOptions = {},
): ParsedDocument {
  const kind = options.kind ?? "resource";
  const diagnostics: GodotParseDiagnostic[] = [];
  const document: ParsedDocument = {
    kind,
    header: null,
    extResources: [],
    subResources: [],
    nodes: [],
    connections: [],
    editables: [],
    properties: {},
    diagnostics,
  };
  let current: CurrentSection = { kind: "document" };
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const logical = collectLogicalLine(lines, index);
    index = logical.endIndex;
    const line = stripLineComment(logical.raw).trim();
    if (line.length === 0) {
      continue;
    }
    if (line.startsWith("[") && line.endsWith("]")) {
      current = parseSectionHeader(
        line.slice(1, -1),
        lineNumber,
        diagnostics,
        document,
      );
      continue;
    }
    const assignment = splitAssignment(line);
    if (!assignment) {
      diagnostics.push({
        severity: "warning",
        code: "godot_parser_unsupported_line",
        message: "Unsupported Godot text line.",
        line: lineNumber,
      });
      continue;
    }
    const value = parseGodotValue(assignment.value, diagnostics, lineNumber);
    assignProperty(document, current, assignment.key, value);
  }

  return document;
}

export function parseGodotValue(
  source: string,
  diagnostics: GodotParseDiagnostic[] = [],
  line?: number,
): GodotVariant {
  const parser = new ValueParser(source, diagnostics, line);
  const value = parser.parseValue();
  parser.skipTrivia();
  if (!parser.done()) {
    diagnostics.push({
      severity: "warning",
      code: "godot_parser_trailing_value_text",
      message: `Trailing text after Godot value: ${source.slice(parser.position)}`,
      line,
    });
  }
  return value;
}

function parseSectionHeader(
  source: string,
  line: number,
  diagnostics: GodotParseDiagnostic[],
  document: ParsedDocument,
): CurrentSection {
  const [section = "", ...attributeParts] = splitHeaderParts(source);
  const attributes = parseHeaderAttributes(
    attributeParts.join(" "),
    diagnostics,
    line,
  );
  switch (section) {
    case "gd_scene":
    case "gd_resource": {
      const header = { section, attributes };
      document.header = header;
      document.kind = section === "gd_scene" ? "scene" : "resource";
      return { kind: "header", header };
    }
    case "ext_resource": {
      const id = stringAttribute(attributes.id) ?? "";
      const resource: GodotExtResource = {
        id,
        type: stringAttribute(attributes.type),
        path: stringAttribute(attributes.path),
        uid: stringAttribute(attributes.uid),
        attributes,
        properties: {},
      };
      document.extResources.push(resource);
      return { kind: "ext_resource", resource };
    }
    case "sub_resource": {
      const id = stringAttribute(attributes.id) ?? "";
      const resource: GodotSubResource = {
        id,
        type: stringAttribute(attributes.type),
        attributes,
        properties: {},
      };
      document.subResources.push(resource);
      return { kind: "sub_resource", resource };
    }
    case "node": {
      const node: GodotNode = {
        name: stringAttribute(attributes.name) ?? "",
        type: stringAttribute(attributes.type),
        parent: stringAttribute(attributes.parent),
        instance: resourceRefAttribute(attributes.instance),
        attributes,
        properties: {},
      };
      document.nodes.push(node);
      return { kind: "node", node };
    }
    case "connection": {
      const connection: GodotConnection = {
        signal: stringAttribute(attributes.signal),
        from: stringAttribute(attributes.from),
        to: stringAttribute(attributes.to),
        method: stringAttribute(attributes.method),
        attributes,
      };
      document.connections.push(connection);
      return { kind: "connection", connection };
    }
    case "editable": {
      const editable: GodotEditable = {
        path: stringAttribute(attributes.path),
        attributes,
      };
      document.editables.push(editable);
      return { kind: "editable", editable };
    }
    case "resource":
      return { kind: "resource" };
    default:
      diagnostics.push({
        severity: "warning",
        code: "godot_parser_unknown_section",
        message: `Unknown Godot text section: ${section}`,
        line,
      });
      return { kind: "document" };
  }
}

function assignProperty(
  document: ParsedDocument,
  current: CurrentSection,
  key: string,
  value: GodotVariant,
): void {
  switch (current.kind) {
    case "ext_resource":
      current.resource.properties[key] = value;
      break;
    case "sub_resource":
      current.resource.properties[key] = value;
      break;
    case "node":
      current.node.properties[key] = value;
      current.node.propertyEntries ??= [];
      current.node.propertyEntries.push({ name: key, value });
      break;
    case "header":
      current.header.attributes[key] = value;
      break;
    case "connection":
      current.connection.attributes[key] = value;
      break;
    case "editable":
      current.editable.attributes[key] = value;
      break;
    case "resource":
      document.properties[key] = value;
      break;
    case "document":
      document.properties[key] = value;
      break;
  }
}

function godotSceneStateFromDocument(
  document: ParsedDocument,
): GodotSceneState {
  const basePath = stringAttribute(document.header?.attributes.path);
  return {
    kind: "scene",
    nodes: document.nodes.map(godotSceneStateNodeFromDocumentNode),
    connections: document.connections.map(
      godotSceneStateConnectionFromDocumentConnection,
    ),
    extResources: document.extResources,
    subResources: document.subResources,
    editableInstances: document.editables
      .map((editable) => editable.path)
      .filter((path): path is string => typeof path === "string"),
    ...(basePath ? { basePath } : {}),
    diagnostics: document.diagnostics,
  };
}

function godotResourceFromDocument(document: ParsedDocument): GodotResource {
  return {
    type: stringAttribute(document.header?.attributes.type),
    header: document.header,
    extResources: document.extResources,
    subResources: document.subResources,
    properties: document.properties,
    diagnostics: document.diagnostics,
  };
}

function godotSceneStateNodeFromDocumentNode(
  node: GodotNode,
  index: number,
): GodotSceneStateNode {
  const owner = stringAttribute(node.attributes.owner);
  const instancePlaceholder =
    stringAttribute(node.attributes.instance_placeholder) ??
    stringAttribute(node.attributes.instancePlaceholder);
  const siblingIndex = nodeIndexAttribute(node.attributes.index);
  return {
    index,
    ...(siblingIndex !== undefined ? { siblingIndex } : {}),
    name: node.name,
    ...(node.type !== undefined ? { type: node.type } : {}),
    parent: node.parent ?? ".",
    ...(owner !== undefined ? { owner } : {}),
    ...(node.instance !== undefined ? { instance: node.instance } : {}),
    ...(instancePlaceholder !== undefined ? { instancePlaceholder } : {}),
    groups: stringArrayAttribute(node.attributes.groups),
    properties:
      node.propertyEntries?.map((property) => ({ ...property })) ??
      Object.entries(node.properties).map(([name, value]) => ({ name, value })),
  };
}

function godotSceneStateConnectionFromDocumentConnection(
  connection: GodotConnection,
): GodotSceneStateConnection {
  const flags = numberAttribute(connection.attributes.flags);
  const binds = godotValueArrayAttribute(connection.attributes.binds);
  const unbinds = numberAttribute(connection.attributes.unbinds);
  return {
    ...(connection.signal !== undefined ? { signal: connection.signal } : {}),
    ...(connection.from !== undefined ? { from: connection.from } : {}),
    ...(connection.to !== undefined ? { to: connection.to } : {}),
    ...(connection.method !== undefined ? { method: connection.method } : {}),
    ...(flags !== undefined ? { flags } : {}),
    ...(binds !== undefined ? { binds } : {}),
    ...(unbinds !== undefined ? { unbinds } : {}),
  };
}

function collectLogicalLine(
  lines: string[],
  startIndex: number,
): { raw: string; endIndex: number } {
  // Scan incrementally, carrying the open-value state across appended lines —
  // re-scanning the accumulated string per appended line is quadratic, which
  // dominated whole-document parse time on multi-line values (packed arrays,
  // animation tracks, shader code in .tres).
  const state = newOpenValueState();
  const parts = [lines[startIndex] ?? ""];
  scanOpenValue(parts[0], state);
  let endIndex = startIndex;
  while (isOpenValue(state) && endIndex + 1 < lines.length) {
    endIndex += 1;
    const line = lines[endIndex] ?? "";
    parts.push(line);
    scanOpenValue(`\n${line}`, state);
  }
  return { raw: parts.join("\n"), endIndex };
}

interface OpenValueState {
  quote: string | null;
  escaped: boolean;
  inComment: boolean;
  squareDepth: number;
  curlyDepth: number;
  parenDepth: number;
}

function newOpenValueState(): OpenValueState {
  return {
    quote: null,
    escaped: false,
    inComment: false,
    squareDepth: 0,
    curlyDepth: 0,
    parenDepth: 0,
  };
}

function isOpenValue(state: OpenValueState): boolean {
  return (
    state.quote !== null ||
    state.squareDepth > 0 ||
    state.curlyDepth > 0 ||
    state.parenDepth > 0
  );
}

function scanOpenValue(source: string, state: OpenValueState): void {
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (state.inComment) {
      if (char === "\n") {
        state.inComment = false;
      }
      continue;
    }
    if (state.quote) {
      if (state.escaped) {
        state.escaped = false;
      } else if (char === "\\") {
        state.escaped = true;
      } else if (char === state.quote) {
        state.quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      state.quote = char;
    } else if (char === ";") {
      state.inComment = true;
    } else if (char === "[") {
      state.squareDepth += 1;
    } else if (char === "]") {
      state.squareDepth = Math.max(0, state.squareDepth - 1);
    } else if (char === "{") {
      state.curlyDepth += 1;
    } else if (char === "}") {
      state.curlyDepth = Math.max(0, state.curlyDepth - 1);
    } else if (char === "(") {
      state.parenDepth += 1;
    } else if (char === ")") {
      state.parenDepth = Math.max(0, state.parenDepth - 1);
    }
  }
}

function stripLineComment(line: string): string {
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ";") {
      return line.slice(0, index);
    }
  }
  return line;
}

function splitAssignment(line: string): { key: string; value: string } | null {
  const index = line.indexOf("=");
  if (index < 0) {
    return null;
  }
  return {
    key: line.slice(0, index).trim(),
    value: line.slice(index + 1).trim(),
  };
}

function splitHeaderParts(source: string): string[] {
  const parts: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (index > start) {
        parts.push(source.slice(start, index));
      }
      start = index + 1;
    }
  }
  if (start < source.length) {
    parts.push(source.slice(start));
  }
  return parts;
}

function parseHeaderAttributes(
  source: string,
  diagnostics: GodotParseDiagnostic[],
  line: number,
): Record<string, GodotVariant> {
  const attributes: Record<string, GodotVariant> = {};
  const attrPattern = /([A-Za-z0-9_./-]+)=/g;
  const matches = [...source.matchAll(attrPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (match.index === undefined) {
      continue;
    }
    const key = match[1] ?? "";
    const valueStart = match.index + match[0].length;
    const valueEnd = matches[index + 1]?.index ?? source.length;
    attributes[key] = parseGodotValue(
      source.slice(valueStart, valueEnd).trim(),
      diagnostics,
      line,
    );
  }
  return attributes;
}

function stringAttribute(value: GodotVariant | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberAttribute(value: GodotVariant | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

// Godot serializes the node header `index` as a quoted string (e.g. `index="3"`),
// so accept a numeric string as well as a bare number.
function nodeIndexAttribute(
  value: GodotVariant | undefined,
): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

function stringArrayAttribute(value: GodotVariant | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function godotValueArrayAttribute(
  value: GodotVariant | undefined,
): GodotVariant[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function resourceRefAttribute(
  value: GodotVariant | undefined,
): GodotResourceRefValue | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "ExtResource" || value.type === "SubResource") &&
    "id" in value &&
    typeof value.id === "string"
  ) {
    const type = value.type;
    return { type, id: value.id };
  }
  return undefined;
}

class ValueParser {
  position = 0;

  constructor(
    private readonly source: string,
    private readonly diagnostics: GodotParseDiagnostic[],
    private readonly line?: number,
  ) {}

  parseValue(): GodotVariant {
    this.skipTrivia();
    const char = this.peek();
    if (char === '"' || char === "'") {
      return this.parseString();
    }
    if (char === "[") {
      return this.parseArray();
    }
    if (char === "{") {
      return this.parseDictionary();
    }
    if (char === "&") {
      return this.parseStringName();
    }
    if (char === "-" || char === "+" || char === "." || isDigit(char)) {
      return this.parseNumber();
    }
    const ident = this.parseIdentifier();
    if (ident.length === 0) {
      this.warn("godot_parser_empty_value", "Expected a Godot value.");
      return null;
    }
    if (ident === "true") {
      return true;
    }
    if (ident === "false") {
      return false;
    }
    if (ident === "null" || ident === "nil") {
      return null;
    }
    this.skipTrivia();
    if (this.peek() === "(") {
      return this.parseCall(ident);
    }
    return ident;
  }

  skipTrivia(): void {
    while (!this.done() && /\s/.test(this.peek())) {
      this.position += 1;
    }
  }

  done(): boolean {
    return this.position >= this.source.length;
  }

  peek(): string {
    return this.source[this.position] ?? "";
  }

  private parseString(): string {
    const quote = this.peek();
    this.position += 1;
    let result = "";
    let escaped = false;
    while (!this.done()) {
      const char = this.peek();
      this.position += 1;
      if (escaped) {
        result += decodeEscape(char);
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        return result;
      } else {
        result += char;
      }
    }
    this.warn("godot_parser_unterminated_string", "Unterminated Godot string.");
    return result;
  }

  private parseArray(): GodotVariant[] {
    this.position += 1;
    const values: GodotVariant[] = [];
    while (!this.done()) {
      this.skipTrivia();
      if (this.peek() === "]") {
        this.position += 1;
        return values;
      }
      values.push(this.parseValue());
      this.skipTrivia();
      if (this.peek() === ",") {
        this.position += 1;
      }
    }
    this.warn("godot_parser_unterminated_array", "Unterminated Godot array.");
    return values;
  }

  private parseDictionary(): Record<string, GodotVariant> {
    this.position += 1;
    const result: Record<string, GodotVariant> = {};
    while (!this.done()) {
      this.skipTrivia();
      if (this.peek() === "}") {
        this.position += 1;
        return result;
      }
      const keyValue = this.parseValue();
      this.skipTrivia();
      if (this.peek() !== ":") {
        this.warn(
          "godot_parser_dictionary_colon_missing",
          "Expected ':' in Godot dictionary.",
        );
        return result;
      }
      this.position += 1;
      const value = this.parseValue();
      result[dictionaryKey(keyValue)] = value;
      this.skipTrivia();
      if (this.peek() === ",") {
        this.position += 1;
      }
    }
    this.warn(
      "godot_parser_unterminated_dictionary",
      "Unterminated Godot dictionary.",
    );
    return result;
  }

  private parseNumber(): number {
    const start = this.position;
    if (this.peek() === "+" || this.peek() === "-") {
      this.position += 1;
    }
    while (isDigit(this.peek())) {
      this.position += 1;
    }
    if (this.peek() === ".") {
      this.position += 1;
      while (isDigit(this.peek())) {
        this.position += 1;
      }
    }
    if (this.peek().toLowerCase() === "e") {
      this.position += 1;
      if (this.peek() === "+" || this.peek() === "-") {
        this.position += 1;
      }
      while (isDigit(this.peek())) {
        this.position += 1;
      }
    }
    return Number(this.source.slice(start, this.position));
  }

  private parseIdentifier(): string {
    const start = this.position;
    while (!this.done() && /[A-Za-z0-9_./:-]/.test(this.peek())) {
      this.position += 1;
    }
    if (this.peek() === "[") {
      this.position += 1;
      while (!this.done() && this.peek() !== "]") {
        if (!/[A-Za-z0-9_./:-]/.test(this.peek())) {
          break;
        }
        this.position += 1;
      }
      if (this.peek() === "]") {
        this.position += 1;
      }
    }
    return this.source.slice(start, this.position);
  }

  private parseStringName(): GodotVariant {
    this.position += 1;
    if (this.peek() === '"' || this.peek() === "'") {
      return { type: "StringName", args: [this.parseString()] };
    }
    this.warn(
      "godot_parser_string_name_expected_string",
      "Expected quoted string after '&' StringName marker.",
    );
    return { type: "StringName", args: [""] };
  }

  private parseCall(name: string): GodotVariant {
    this.position += 1;
    const args: GodotVariant[] = [];
    while (!this.done()) {
      this.skipTrivia();
      if (this.peek() === ")") {
        this.position += 1;
        return callValue(name, args);
      }
      args.push(this.parseValue());
      this.skipTrivia();
      if (this.peek() === ",") {
        this.position += 1;
      }
    }
    this.warn(
      "godot_parser_unterminated_call",
      `Unterminated Godot call ${name}(...).`,
    );
    return callValue(name, args);
  }

  private warn(code: string, message: string): void {
    this.diagnostics.push({
      severity: "warning",
      code,
      message,
      line: this.line,
      column: this.position + 1,
    });
  }
}

function callValue(name: string, args: GodotVariant[]): GodotVariant {
  const numericArgs = args.map((arg) =>
    typeof arg === "number" ? arg : Number.NaN,
  );
  switch (name) {
    case "Vector2":
    case "Vector2i":
    case "Vector3":
    case "Vector3i":
    case "Vector4":
    case "Vector4i":
      return { type: name, args: numericArgs };
    case "Color":
      return { type: "Color", args: numericArgs };
    case "Rect2":
    case "Rect2i":
      return { type: name, args: numericArgs };
    case "NodePath":
      return {
        type: "NodePath",
        args: [typeof args[0] === "string" ? args[0] : ""],
      };
    case "ExtResource":
    case "SubResource":
      return { type: name, id: String(args[0] ?? "") };
    default:
      // Any other constructor (PackedVector2Array, Transform2D, …): keep the
      // engine-native `{ type, args }` shape with the constructor name as type.
      return { type: name, args };
  }
}

function decodeEscape(char: string): string {
  switch (char) {
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    default:
      return char;
  }
}

function dictionaryKey(value: GodotVariant): string {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "type" in value &&
    value.type === "StringName" &&
    "args" in value &&
    Array.isArray(value.args) &&
    typeof value.args[0] === "string"
  ) {
    return value.args[0];
  }
  return JSON.stringify(value);
}

function isDigit(value: string): boolean {
  return value >= "0" && value <= "9";
}
