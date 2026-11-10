import { createInterface } from 'node:readline';

const mode = process.env.FAKE_MSX_MODE || 'pass';
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (!request.id) return;
  let result;
  if (request.method === 'initialize') {
    if (mode === 'invalid-protocol') {
      process.stdout.write('not json\n');
      return;
    }
    if (mode === 'null-response' || mode === 'invalid-envelope') {
      process.stdout.write(mode === 'null-response' ? 'null\n' : `${JSON.stringify({ id: request.id, result: {} })}\n`);
      return;
    }
    result = { protocolVersion: '2025-03-26', capabilities: {} };
  } else if (request.method === 'tools/list') {
    if (mode === 'pagination' && !request.params?.cursor) result = { tools: [], nextCursor: 'second' };
    else if (mode === 'cursor-loop') result = { tools: [], nextCursor: 'same' };
    else result = { tools: mode === 'missing' ? [] : [{
      name: 'msx_auth_status',
      ...(mode === 'unannotated' ? {} : { annotations: { readOnlyHint: true,
        ...(mode === 'missing-destructive' ? {} : { destructiveHint: mode === 'destructive' }) } }),
    }] };
  } else if (request.method === 'tools/call') {
    if (['unannotated', 'missing-destructive', 'destructive'].includes(mode)
      || request.params?.name !== 'msx_auth_status' || Object.keys(request.params?.arguments ?? {}).length) {
      throw new Error('Only the read-only status call is permitted.');
    }
    const text = ['pass', 'pagination', 'conflicting', 'invalid-token'].includes(mode)
      ? '✅ **Azure CLI:** Signed in\n✅ **Dataverse token:** Valid\n✅ **Dataverse:** Connected (UserId: `private`)\n🎉 **All checks passed!**'
      : mode === 'action' ? '❌ **Azure CLI: Not signed in**'
        : mode === 'not-installed' ? '❌ **Azure CLI: Not installed**'
          : mode === 'wrong-tenant' ? '⚠️ **Azure CLI: Wrong tenant**'
            : mode === 'token-unavailable' ? '❌ **Dataverse token: Cannot acquire**'
              : mode === 'forbidden' ? '❌ **Access: Forbidden**' : 'A changed diagnostic format';
    result = { ...(mode === 'tool-error' ? { isError: true } : {}),
      content: [{ type: 'text', text: mode === 'conflicting' ? `${text}\n❌ **Access: Forbidden**`
        : mode === 'invalid-token' ? text.replace('token:** Valid', 'token:** Invalid') : text }] };
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
});
