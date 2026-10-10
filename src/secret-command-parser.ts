/** Only standalone requests change mode; quoted examples and mixed content do not. */
export function parseSecretCommand(text?: string): 'on' | 'off' | 'status' | undefined {
  const input = text?.trim();
  if (!input) return;
  const command = input.match(/^\/secret(?:@[a-z0-9_]+)?(?:\s+(on|off|status))?$/i);
  if (command) return (command[1]?.toLowerCase() || 'status') as 'on' | 'off' | 'status';
  const request = input.replace(/[。！!？?]+$/, '').trim();
  const subject = 'シークレット(?:モード)?';
  const polite = '(?:ください|下さい|くれる|もらえる)?';
  if (new RegExp(`^${subject}(?:にして|を(?:開始|有効に|オンに)して)${polite}$`).test(request))
    return 'on';
  if (new RegExp(`^${subject}(?:を)?(?:終了|解除|無効に|オフに)して${polite}$`).test(request))
    return 'off';
  if (
    new RegExp(
      `^(?:今(?:は)?${subject}(?:ですか)?|${subject}(?:ですか|の状態を(?:教えて|確認して)${polite}))$`
    ).test(request)
  )
    return 'status';
}
