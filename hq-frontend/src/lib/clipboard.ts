/**
 * Clipboard copy with a fallback for non-secure origins (AGENTS §4.5 outlets
 * may serve the console over plain LAN HTTP, where `navigator.clipboard` is
 * undefined). Returns whether the copy succeeded so callers can notify —
 * a silent failure here strands a provisioning operator with nothing on
 * their clipboard.
 */
/** Navigator without the DOM lib's secure-context-only clipboard guarantee. */
type PossiblyClipboardless = { clipboard?: Clipboard }

export async function copyText(text: string): Promise<boolean> {
  // DOM typings claim `navigator.clipboard` always exists, but it is undefined
  // at runtime on non-secure origins — widen the type so the check is honest.
  const clipboard = (navigator as unknown as PossiblyClipboardless).clipboard
  if (clipboard) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the legacy path — permissions can still deny.
    }
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}
