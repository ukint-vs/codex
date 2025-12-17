import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runEthexeTx } from './ethexe.ts';
import { spawnSync } from 'child_process';
import * as api from '@vara-eth/api';

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}));

vi.mock('@vara-eth/api', async (importOriginal) => {
  const actual = await importOriginal<typeof api>();
  return {
    ...actual,
    getMirrorClient: vi.fn(),
    getRouterClient: vi.fn(),
    EthereumClient: vi.fn().mockImplementation(function() {
      return {
        isInitialized: Promise.resolve(),
        walletClient: { account: { address: '0xsender' } },
        publicClient: {},
      };
    }),
    VaraEthApi: vi.fn().mockImplementation(function(provider, ethClient) {
      return {
        ethereumClient: ethClient,
      };
    }),
    WsVaraEthProvider: vi.fn(),
  };
});

describe('runEthexeTx', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call spawnSync for upload command', async () => {
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: Buffer.from(JSON.stringify({ code_id: '0x123' })),
      stderr: Buffer.from(''),
      output: [],
      pid: 123,
      signal: null,
    } as any);

    const result = await runEthexeTx(['upload', '-w', '-j', 'some.wasm']);
    expect(spawnSync).toHaveBeenCalled();
    expect(result).toEqual({ code_id: '0x123' });
  });

  it('should use @vara-eth/api for send-message', async () => {
    const mockTx = {
      sendAndWaitForReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        transactionHash: '0xhash',
      }),
    };
    const mockMirror = {
      sendMessage: vi.fn().mockResolvedValue(mockTx),
    };
    vi.mocked(api.getMirrorClient).mockReturnValue(mockMirror as any);

    const result = await runEthexeTx(['send-message', '0x123', '0x456', '0']);
    
    expect(api.getMirrorClient).toHaveBeenCalledWith('0x123', expect.anything(), expect.anything());
    expect(mockMirror.sendMessage).toHaveBeenCalledWith('0x456', 0n);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'success',
      transaction_hash: '0xhash',
      ok: true,
    });
  });

  it('should use @vara-eth/api for create', async () => {
    const mockTx = {
      sendAndWaitForReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        transactionHash: '0xhash',
      }),
      getProgramId: vi.fn().mockResolvedValue('0xprogram'),
    };
    const mockRouter = {
      createProgram: vi.fn().mockResolvedValue(mockTx),
    };
    vi.mocked(api.getRouterClient).mockReturnValue(mockRouter as any);

    const result = await runEthexeTx(['create', '0xcode', '--salt', '0xsalt', '-j']);
    
    expect(api.getRouterClient).toHaveBeenCalledWith(expect.any(String), expect.anything(), expect.anything());
    expect(mockRouter.createProgram).toHaveBeenCalledWith('0xcode', '0xsalt');
    expect(spawnSync).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'success',
      transaction_hash: '0xhash',
      actor_id: '0xprogram',
      ok: true,
    });
  });

  it('should use @vara-eth/api for topup-exec', async () => {
    const mockTx = {
      sendAndWaitForReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        transactionHash: '0xhash',
      }),
    };
    const mockMirror = {
      executableBalanceTopUp: vi.fn().mockResolvedValue(mockTx),
    };
    vi.mocked(api.getMirrorClient).mockReturnValue(mockMirror as any);

    const result = await runEthexeTx(['topup-exec', '0xprogram', '1000']);
    
    expect(api.getMirrorClient).toHaveBeenCalledWith('0xprogram', expect.anything(), expect.anything());
    expect(mockMirror.executableBalanceTopUp).toHaveBeenCalledWith(1000n);
    expect(spawnSync).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'success',
      transaction_hash: '0xhash',
      ok: true,
    });
  });
});
