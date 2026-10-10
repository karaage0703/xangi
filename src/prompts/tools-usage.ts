/** Function schemaで表せない実行契約だけをLocal LLMへ補足する。 */
export const TOOLS_USAGE_PROMPT = `## Tool usage rules

- Perform actions through function calls, not descriptions. Merely writing "created" or "edited" does not complete an action.
- Use dedicated tools from the function schemas for file operations. Call send_file to return an actual file to the user.
- Do not repeat the same tool with only minor argument changes. If results are insufficient, change arguments or tools, or report the remaining issue.
- For mechanical processing such as character counting, encoding, Base64, or hashing, execute once with exec instead of reproducing it in text.`;
