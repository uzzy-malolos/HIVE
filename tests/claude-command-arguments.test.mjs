import assert from "node:assert/strict";
import test from "node:test";
import { renderSkillArguments } from "../dist/extensions/skill-arguments.js";

test("explicit skill arguments render full, indexed, and numeric forms with quoted positional values", () => {
  const argumentsText = '"hello world" second \'third value\' ""';
  assert.equal(renderSkillArguments("All: $ARGUMENTS\nValues: $0 | $ARGUMENTS[1] | $2 | $3 | $4", argumentsText),
    `All: ${argumentsText}\nValues: hello world | second | third value |  | $4`);
  assert.equal(renderSkillArguments("$0 $1", 'pre"joined value" x\\ y'), "prejoined value x y");
  assert.equal(renderSkillArguments("$0", '"C:\\workspace\\file.md"'), "C:\\workspace\\file.md");
});

test("argument values remain literal and cannot introduce a second substitution or shell execution", () => {
  assert.equal(renderSkillArguments("Value: $0", "'$ARGUMENTS $1 !`touch ignored` $(touch ignored)'"),
    "Value: $ARGUMENTS $1 !`touch ignored` $(touch ignored)");
  assert.equal(renderSkillArguments("$ARGUMENTS", "${CLAUDE_PLUGIN_ROOT}"), "${CLAUDE_PLUGIN_ROOT}");
  assert.equal(renderSkillArguments("$ARGUMENTS", "Explain why it's broken"), "Explain why it's broken");
});

test("a single backslash escapes supported placeholders while doubled backslashes preserve substitution", () => {
  assert.equal(renderSkillArguments(String.raw`Literal: \$0 \$ARGUMENTS \$ARGUMENTS[0]; values: \\$0 \\$ARGUMENTS[0]`, "value"),
    String.raw`Literal: $0 $ARGUMENTS $ARGUMENTS[0]; values: \\value \\value`);
  assert.equal(renderSkillArguments(String.raw`\$0 \$other`, "value"), "$0 \\$other\n\nARGUMENTS: value");
});

test("arguments without a matching placeholder append once and unknown placeholders remain literal", () => {
  assert.equal(renderSkillArguments("Use this skill.", "some input"), "Use this skill.\n\nARGUMENTS: some input");
  assert.equal(renderSkillArguments("Use this skill.\n", "some input"), "Use this skill.\n\nARGUMENTS: some input");
  assert.equal(renderSkillArguments("$2 $ARGUMENTS[2] $other $ARGUMENTSsuffix $1suffix", "one"),
    "$2 $ARGUMENTS[2] $other $ARGUMENTSsuffix $1suffix\n\nARGUMENTS: one");
  assert.equal(renderSkillArguments("No arguments.", ""), "No arguments.");
  assert.equal(renderSkillArguments("No placeholders.", "It's broken"), "No placeholders.\n\nARGUMENTS: It's broken");
  assert.equal(renderSkillArguments("$ARGUMENTS|$0", ""), "|$0");
});

test("skill frontmatter stays unchanged and unsupported named arguments fail visibly", () => {
  const header = '---\r\nname: sample\r\ndescription: $ARGUMENTS and $0\r\nuser-invocable: true\r\n---\r\n';
  assert.equal(renderSkillArguments(`${header}Body: $0`, "value"), `${header}Body: value`);
  for (const field of ["arguments: [issue, branch]", '"arguments": issue branch', "  'arguments':\n  - issue"]) {
    assert.throws(() => renderSkillArguments(`---\n${field}\n---\nUse $issue`, "one"), /Named skill arguments are not supported/u);
  }
  assert.throws(() => renderSkillArguments("---\nname: unfinished", "one"), /Unterminated skill frontmatter/u);
  assert.throws(() => renderSkillArguments("---\nuser-invocable: false\n---\nUse $ARGUMENTS", "one"), /not available as a user-invoked/u);
});

test("malformed quoting and excessive rendered instructions fail before use", () => {
  for (const argumentsText of ['"unterminated', "'unterminated", "incomplete\\"]) {
    assert.throws(() => renderSkillArguments("$0", argumentsText), /unterminated quote|incomplete escape/u);
  }
  assert.throws(() => renderSkillArguments("x".repeat(65537), ""), /65536 bytes/u);
  assert.throws(() => renderSkillArguments("$0", "x".repeat(65537)), /65536 bytes/u);
  assert.throws(() => renderSkillArguments("$ARGUMENTS".repeat(5), "x".repeat(15000)), /Rendered skill instructions exceed/u);
  assert.throws(() => renderSkillArguments("$ARGUMENTS".repeat(5), "界".repeat(5000)), /Rendered skill instructions exceed/u);
});
