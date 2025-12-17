export function ensure(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function toActorId32(value: string | undefined, name: string): `0x${string}` {
  const raw = ensure(value, name);
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (hex.length === 40) return `0x${hex.padStart(64, '0')}` as `0x${string}`;
  if (hex.length === 64) return `0x${hex}` as `0x${string}`;
  throw new Error(`${name} must be 20-byte or 32-byte hex`);
}

export function toEthAddress(value: string | undefined, name: string): `0x${string}` {
  const raw = ensure(value, name);
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (hex.length === 40) return `0x${hex}` as `0x${string}`;
  if (hex.length === 64 && hex.startsWith('000000000000000000000000')) {
    return `0x${hex.slice(24)}` as `0x${string}`;
  }
  throw new Error(`${name} must be 20-byte hex (40 chars) or 32-byte with leading zeros`);
}

export function toH160(value: string | undefined, name: string): `0x${string}` {
  const raw = ensure(value, name);
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
  if (hex.length !== 40) throw new Error(`${name} must be 20-byte hex (40 chars)`);
  return `0x${hex}` as `0x${string}`;
}

export function parseU128(value: string | undefined, name: string): bigint {
  if (!value) throw new Error(`${name} is required`);
  try {
    const v = BigInt(value);
    if (v < 0n) throw new Error('negative');
    return v;
  } catch {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

export function shouldWatchReplies(): boolean {
  const val = process.env.WATCH_REPLIES;
  if (val === undefined) return true;
  return val.toLowerCase() === 'true';
}

export function payloadToHex(payload: Uint8Array | string): `0x${string}` {
  if (typeof payload === 'string') {
    const hex = payload.startsWith('0x') ? payload.slice(2) : payload;
    return `0x${hex}` as `0x${string}`;
  }
  // If payload bytes are ascii "0x..." treat it as hex string
  if (payload.length >= 2 && payload[0] === 0x30 && (payload[1] === 0x78 || payload[1] === 0x58)) {
    const str = Buffer.from(payload).toString();
    const hex = str.startsWith('0x') ? str.slice(2) : str;
    return `0x${hex}` as `0x${string}`;
  }
  return `0x${Buffer.from(payload).toString('hex')}` as `0x${string}`;
}

export function hexToBytes(value: string | undefined, name: string): Uint8Array {
  const hex = ensure(value, name).replace(/^0x/i, '');
  if (hex.length % 2 !== 0) {
    throw new Error(`${name} hex must have even length`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function decodePayload(payload: string | undefined): { hex: string; utf8?: string } {
  if (!payload || payload === '0x') return { hex: '0x' };
  const hex = payload.startsWith('0x') ? payload : `0x${payload}`;
  let utf8: string | undefined;
  try {
    const buf = Buffer.from(hex.slice(2), 'hex');
    const text = buf.toString('utf8');
    // Heuristic: only show utf8 if printable
    if (/^[\x09\x0A\x0D\x20-\x7E]*$/.test(text)) {
      utf8 = text;
    }
  } catch {
    // ignore
  }
  return { hex, utf8 };
}

export function logReplyInfo(result: any) {
  const reply = result?.reply_info;
  if (!reply) {
    console.log('Reply: no reply in output');
    return;
  }
  const decoded = decodePayload(reply.payload as string | undefined);
  console.log('Reply:', {
    actor_id: reply.actor_id,
    code: reply.code,
    message_id: reply.message_id,
    payload_hex: decoded.hex,
    payload_utf8: decoded.utf8,
    value: reply.value,
  });
}
