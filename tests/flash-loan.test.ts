import { FlashLoanModule } from '../src/modules/flash-loan';
import { FlashLoanError, ValidationError } from '../src/errors';

const VALID_PAIR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
const VALID_TOKEN = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';

describe('FlashLoanModule (unit)', () => {
  let mockPair: any;
  let mockClient: any;
  let module: FlashLoanModule;

  beforeEach(() => {
    mockPair = {
      getFlashLoanConfig: jest.fn().mockResolvedValue({
        locked: false,
        flashFeeBps: 50,
        flashFeeFloor: 5,
      }),
      getReserves: jest.fn().mockResolvedValue({ reserve0: 100000n, reserve1: 50000n }),
      getTokens: jest.fn().mockResolvedValue({ token0: VALID_TOKEN, token1: 'CA...OTHER' }),
      buildFlashLoan: jest.fn().mockReturnValue({ op: 'fake-op' }),
    };

    mockClient = {
      pair: jest.fn().mockReturnValue(mockPair),
      publicKey: 'GFAKEPUBLICKEYEXAMPLEXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      simulateTransaction: jest.fn(),
      submitTransaction: jest.fn().mockResolvedValue({ success: true, txHash: '0xdead', data: { ledger: 42 } }),
    };

    module = new FlashLoanModule(mockClient as any);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('isAvailable() returns true when flash loans unlocked', async () => {
    mockPair.getFlashLoanConfig.mockResolvedValueOnce({ locked: false });
    const res = await module.isAvailable(VALID_PAIR);
    expect(res).toBe(true);
  });

  it('isAvailable() returns false when pair not found', async () => {
    mockPair.getFlashLoanConfig.mockRejectedValueOnce(new Error('PAIR_NOT_FOUND'));
    const res = await module.isAvailable(VALID_PAIR);
    expect(res).toBe(false);
  });

  it('estimateFee() computes fees correctly and honours fee floor', async () => {
    // small amount: fee config uses floor when the configured floor is higher than bps-derived fee
    mockPair.getFlashLoanConfig.mockResolvedValueOnce({ locked: false, flashFeeBps: 100, flashFeeFloor: 100 });
    const low = await module.estimateFee(VALID_PAIR, VALID_TOKEN, 10000n);
    expect(low.feeAmount).toEqual(100n);

    // larger amount: bps-derived fee exceeds the same configured floor
    mockPair.getFlashLoanConfig.mockResolvedValueOnce({ locked: false, flashFeeBps: 150, flashFeeFloor: 100 });
    const high = await module.estimateFee(VALID_PAIR, VALID_TOKEN, 100000n);
    expect(high.feeAmount).toEqual(1500n);
  });

  it('estimateFee() rejects when fee config is below protocol floor', async () => {
    mockPair.getFlashLoanConfig.mockResolvedValueOnce({ locked: false, flashFeeBps: 3, flashFeeFloor: 5 });
    await expect(module.estimateFee(VALID_PAIR, VALID_TOKEN, 10000n)).rejects.toThrow(FlashLoanError);
  });

  it('execute() rejects malformed receiver addresses', async () => {
    const req = {
      pairAddress: VALID_PAIR,
      token: VALID_TOKEN,
      amount: 1000n,
      receiverAddress: 'not-an-address',
      callbackData: Buffer.from([]),
    } as any;

    await expect(module.execute(req)).rejects.toThrow(ValidationError);
  });

  it('calculateRepayment() returns expected repayment value', () => {
    const total = module.calculateRepayment(10000n, 50);
    // fee = (10000 * 50)/10000 = 50
    expect(total).toEqual(10050n);
  });
});
