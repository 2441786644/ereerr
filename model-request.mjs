export function applyFastMode(payload, mode, fastMode) {
  if (!fastMode) return payload
  if (mode === 'dashscope') {
    return { ...payload, parameters: { ...payload.parameters, enable_thinking: false } }
  }
  return { ...payload, enable_thinking: false }
}
