const SGR = /^\x1b\[(?:0|(?:38|48);2;\d{1,3};\d{1,3};\d{1,3})m$/;

export function cleanTerminalControls(input: string, preserveRendererColors: boolean): string {
  const text = input.replace(/\r\n?/g, "\n");
  let result = "";
  for (let index = 0; index < text.length;) {
    const code = text.charCodeAt(index);
    const escape = code === 0x1b;
    const next = escape ? text.charCodeAt(index + 1) : code;
    const csi = escape ? next === 0x5b : code === 0x9b;
    const controlString = escape
      ? next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f
      : code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f;
    if (controlString) {
      index += escape ? 2 : 1;
      while (index < text.length) {
        const char = text.charCodeAt(index++);
        if (char === 0x07 || char === 0x9c) break;
        if (char === 0x1b && text.charCodeAt(index) === 0x5c) {
          index += 1;
          break;
        }
      }
      continue;
    }
    if (csi) {
      const start = index;
      index += escape ? 2 : 1;
      while (index < text.length) {
        const char = text.charCodeAt(index++);
        if (char >= 0x40 && char <= 0x7e) break;
      }
      const sequence = text.slice(start, index);
      if (preserveRendererColors && SGR.test(sequence)) result += sequence;
      continue;
    }
    if (escape) {
      index += 1;
      while (text.charCodeAt(index) >= 0x20 && text.charCodeAt(index) <= 0x2f) index += 1;
      if (text.charCodeAt(index) >= 0x30 && text.charCodeAt(index) <= 0x7e) index += 1;
      continue;
    }
    index += 1;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)) continue;
    result += text[index - 1];
  }
  return result;
}

/** Drop CSI, OSC (including clipboard/hyperlinks), DCS, other escapes and C0/C1 controls. */
export function sanitizeTerminalText(input: string): string {
  return cleanTerminalControls(input, false);
}

