const MAX_SKILL_ARGUMENT_BYTES = 64 * 1024;

function argumentValues(text: string): string[] {
  const values: string[] = [];
  let value = "";
  let started = false;
  let quote: "single" | "double" | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else value += character;
      continue;
    }
    if (character === "\\") {
      const next = text[index + 1];
      if (next === undefined) throw new Error("Skill arguments end with an incomplete escape.");
      if (quote === "double" && !['"', "\\", "$", "`"].includes(next)) value += character;
      else { value += next; index += 1; }
      started = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = undefined;
      else value += character;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character === "'" ? "single" : "double";
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) { values.push(value); value = ""; started = false; }
    } else { value += character; started = true; }
  }
  if (quote) throw new Error("Skill arguments contain an unterminated quote.");
  if (started) values.push(value);
  return values;
}

/** Render an explicit invocation as text; arguments never enter a shell or another substitution pass. */
export function renderSkillArguments(text: string, argumentsText: string): string {
  if (Buffer.byteLength(text) > MAX_SKILL_ARGUMENT_BYTES || Buffer.byteLength(argumentsText) > MAX_SKILL_ARGUMENT_BYTES) {
    throw new Error("Skill instructions and arguments must each stay within 65536 bytes.");
  }
  const frontmatter = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text);
  if (!frontmatter && /^\uFEFF?---[ \t]*(?:\r?\n|$)/u.test(text)) throw new Error("Unterminated skill frontmatter.");
  if (frontmatter && /^[ \t]*(?:arguments|"arguments"|'arguments')[ \t]*:/mu.test(frontmatter[1])) {
    throw new Error("Named skill arguments are not supported; use $ARGUMENTS, $ARGUMENTS[N], or $N instead.");
  }
  const prefix = frontmatter?.[0] ?? "";
  if (frontmatter && /^[ \t]*(?:user-invocable|"user-invocable"|'user-invocable')[ \t]*:[ \t]*(?:false|"false"|'false')[ \t]*(?:#.*)?$/mu.test(frontmatter[1])) throw new Error("This skill is not available as a user-invoked command.");
  const body = text.slice(prefix.length);
  let values: string[] | undefined;
  let substituted = false;
  let renderedBytes = Buffer.byteLength(prefix);
  const chunks: string[] = [prefix];
  let offset = 0;
  const append = (chunk: string) => {
    renderedBytes += Buffer.byteLength(chunk);
    if (renderedBytes > MAX_SKILL_ARGUMENT_BYTES) throw new Error("Rendered skill instructions exceed 65536 bytes.");
    chunks.push(chunk);
  };
  for (const match of body.matchAll(/\$ARGUMENTS(?:\[(\d+)\])?(?![\w[])|\$(\d+)(?!\w)/gu)) {
    const position = match.index;
    const escaped = position > 0 && body[position - 1] === "\\" && (position < 2 || body[position - 2] !== "\\");
    append(body.slice(offset, escaped ? position - 1 : position));
    const index = match[1] ?? match[2];
    if (!escaped && index !== undefined) values ??= argumentValues(argumentsText);
    const argument = index === undefined ? argumentsText : values?.[Number(index)];
    if (escaped || argument === undefined) append(match[0]);
    else { append(argument); substituted = true; }
    offset = position + match[0].length;
  }
  append(body.slice(offset));
  if (!substituted && argumentsText.trim()) append(`${body.endsWith("\n") ? "" : "\n"}\nARGUMENTS: ${argumentsText}`);
  return chunks.join("");
}
