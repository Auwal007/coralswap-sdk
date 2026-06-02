import { OracleModule, TWAPObservation } from '../src/modules/oracle';
import { ValidationError, InsufficientLiquidityError } from '../src/errors';
import { PRECISION } from '../src/config';

const PAIR = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

describe('OracleModule (unit)', () => {
  let mockPair: any;
  let mockClient: any;
  let oracle: OracleModule;

  beforeEach(() => {
    let call = 0;
    mockPair = {
      getCumulativePrices: jest.fn().mockImplementation(async () => {
        // produce deterministic increasing cumulative values and timestamps
        call += 1;
        const base = BigInt(call) * 1000n;
        return {
          price0CumulativeLast: base,
          price1CumulativeLast: base * 2n,
          blockTimestampLast: 100 + call * 10,
        };
      }),
      getTokens: jest.fn().mockResolvedValue({ token0: 'CTOKEN0', token1: 'CTOKEN1' }),
      getReserves: jest.fn().mockResolvedValue({ reserve0: 100n, reserve1: 200n }),
    };

    mockClient = {
      pair: jest.fn().mockReturnValue(mockPair),
    };

    oracle = new OracleModule(mockClient as any);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  it('getTWAP() computes time-weighted average price across observations', async () => {
    // First observation
    await oracle.observe(PAIR);
    // The next call inside getTWAP will append a second observation
    const twap = await oracle.getTWAP(PAIR);
    expect(twap).not.toBeNull();
    if (twap) {
      // price0TWAP = (end - start) / timeElapsed
      const expected = (twap.endObservation.price0CumulativeLast - twap.startObservation.price0CumulativeLast) / BigInt(twap.timeWindow);
      expect(twap.price0TWAP).toEqual(expected);
      expect(twap.timeWindow).toBeGreaterThan(0);
    }
  });

  it('computeTWAP() throws ValidationError for inverted or zero time window', () => {
    const start = { price0CumulativeLast: 2000n, price1CumulativeLast: 4000n, blockTimestampLast: 200 };
    const end = { price0CumulativeLast: 1000n, price1CumulativeLast: 2000n, blockTimestampLast: 100 };
    expect(() => oracle.computeTWAP(start as any, end as any)).toThrow(ValidationError);
  });

  it('observation cache evicts oldest entries when capacity exceeded', async () => {
    // call observe 130 times to force eviction (module keeps only last 100)
    for (let i = 0; i < 130; i++) {
      await oracle.observe(PAIR);
    }

    const count = oracle.getObservationCount(PAIR);
    expect(count).toEqual(100);
  });

  it('computeTWAP() rejects identical timestamps (zero window)', () => {
    const obs = { price0CumulativeLast: 5000n, price1CumulativeLast: 10000n, blockTimestampLast: 100 };
    expect(() => oracle.computeTWAP(obs as any, obs as any)).toThrow(ValidationError);
  });

  it('getSpotPrice() throws InsufficientLiquidityError on zero reserves', async () => {
    (mockPair.getReserves as jest.Mock).mockResolvedValueOnce({ reserve0: 0n, reserve1: 0n });
    await expect(oracle.getSpotPrice(PAIR)).rejects.toThrow(InsufficientLiquidityError);
  });

  it('getTWAP() returns null when insufficient observations exist', async () => {
    // fresh oracle has no cached observations; getTWAP will take one and return null
    const freshOracle = new OracleModule(mockClient as any);
    const maybe = await freshOracle.getTWAP(PAIR);
    expect(maybe).toBeNull();
  });
});

function mockClient(pairOverrides: Record<string, (...args: any[]) => any> = {}) {
  return {
    pair: jest.fn().mockReturnValue({
      getCumulativePrices: jest.fn(),
      getTokens: jest.fn().mockResolvedValue({
        token0: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2ZCMJ',
        token1: 'CCJZ5DGASBWQXR5MPFCJXMBI333XE5U3FSJTNQU7EEESNH5CS4NGOF',
      }),
      getReserves: jest.fn().mockResolvedValue({
        reserve0: 5000000000n,
        reserve1: 10000000000n,
      }),
      ...pairOverrides,
    }),
  } as any;
}

describe('OracleModule', () => {
  describe('computeTWAP', () => {
    let oracle: OracleModule;

    beforeEach(() => {
      oracle = new OracleModule(null as any);
    });

    it('calculates correct TWAP from two observations', () => {
      const start: TWAPObservation = {
        price0CumulativeLast: 1000000000000n,
        price1CumulativeLast: 500000000000n,
        blockTimestampLast: 1000,
      };
      const end: TWAPObservation = {
        price0CumulativeLast: 1600000000000n,
        price1CumulativeLast: 800000000000n,
        blockTimestampLast: 1600,
      };

      const result = oracle.computeTWAP(start, end);

      const expectedPrice0 = (1600000000000n - 1000000000000n) / BigInt(600);
      const expectedPrice1 = (800000000000n - 500000000000n) / BigInt(600);

      expect(result.price0TWAP).toBe(expectedPrice0);
      expect(result.price1TWAP).toBe(expectedPrice1);
      expect(result.timeWindow).toBe(600);
    });

    it('throws when time delta is zero', () => {
      const obs: TWAPObservation = {
        price0CumulativeLast: 1000000000000n,
        price1CumulativeLast: 500000000000n,
        blockTimestampLast: 1000,
      };

      expect(() => oracle.computeTWAP(obs, obs)).toThrow(
        'End observation must be after start observation',
      );
    });

    it('throws when end is before start', () => {
      const start: TWAPObservation = {
        price0CumulativeLast: 1000000000000n,
        price1CumulativeLast: 500000000000n,
        blockTimestampLast: 2000,
      };
      const end: TWAPObservation = {
        price0CumulativeLast: 1600000000000n,
        price1CumulativeLast: 800000000000n,
        blockTimestampLast: 1000,
      };

      expect(() => oracle.computeTWAP(start, end)).toThrow(
        'End observation must be after start observation',
      );
    });
  });

  describe('observe', () => {
    it('caches observations from simulated pair responses', async () => {
      const pairAddress = 'CBQHNAXSI555GX2GS764XZHGMNO5XSARACTBP44JIPYZRVQ73NPFV';

      let callCount = 0;
      const cumulativeResponses = [
        {
          price0CumulativeLast: 100000000n,
          price1CumulativeLast: 200000000n,
          blockTimestampLast: 1000,
        },
        {
          price0CumulativeLast: 400000000n,
          price1CumulativeLast: 800000000n,
          blockTimestampLast: 1300,
        },
      ];

      const client = mockClient({
        getCumulativePrices: jest.fn().mockImplementation(() => {
          return Promise.resolve(cumulativeResponses[callCount++]);
        }),
      });

      const oracle = new OracleModule(client);

      const obs1 = await oracle.observe(pairAddress);
      expect(obs1.price0CumulativeLast).toBe(100000000n);
      expect(obs1.blockTimestampLast).toBe(1000);
      expect(oracle.getObservationCount(pairAddress)).toBe(1);

      const obs2 = await oracle.observe(pairAddress);
      expect(obs2.price0CumulativeLast).toBe(400000000n);
      expect(obs2.blockTimestampLast).toBe(1300);
      expect(oracle.getObservationCount(pairAddress)).toBe(2);
    });
  });

  describe('getTWAP', () => {
    it('returns null when only one observation exists', async () => {
      const pairAddress = 'CBQHNAXSI555GX2GS764XZHGMNO5XSARACTBP44JIPYZRVQ73NPFV';

      const client = mockClient({
        getCumulativePrices: jest.fn().mockResolvedValue({
          price0CumulativeLast: 100000000n,
          price1CumulativeLast: 200000000n,
          blockTimestampLast: 1000,
        }),
      });

      const oracle = new OracleModule(client);
      const result = await oracle.getTWAP(pairAddress);

      expect(result).toBeNull();
    });

    it('returns correct TWAP result after multiple observations', async () => {
      const pairAddress = 'CBQHNAXSI555GX2GS764XZHGMNO5XSARACTBP44JIPYZRVQ73NPFV';

      let callCount = 0;
      const responses = [
        {
          price0CumulativeLast: 1000000000000n,
          price1CumulativeLast: 2000000000000n,
          blockTimestampLast: 10000,
        },
        {
          price0CumulativeLast: 1500000000000n,
          price1CumulativeLast: 3000000000000n,
          blockTimestampLast: 10500,
        },
      ];

      const client = mockClient({
        getCumulativePrices: jest.fn().mockImplementation(() => {
          return Promise.resolve(responses[callCount++]);
        }),
      });

      const oracle = new OracleModule(client);

      await oracle.observe(pairAddress);
      const result = await oracle.getTWAP(pairAddress);

      expect(result).not.toBeNull();
      expect(result!.timeWindow).toBe(500);
      expect(result!.price0TWAP).toBe(
        (1500000000000n - 1000000000000n) / BigInt(500),
      );
      expect(result!.price1TWAP).toBe(
        (3000000000000n - 2000000000000n) / BigInt(500),
      );
      expect(result!.pairAddress).toBe(pairAddress);
    });

    it('returns null when timestamps have not advanced (stale data)', async () => {
      const pairAddress = 'CBQHNAXSI555GX2GS764XZHGMNO5XSARACTBP44JIPYZRVQ73NPFV';

      const staleResponse = {
        price0CumulativeLast: 100000000n,
        price1CumulativeLast: 200000000n,
        blockTimestampLast: 5000,
      };

      const client = mockClient({
        getCumulativePrices: jest.fn().mockResolvedValue(staleResponse),
      });

      const oracle = new OracleModule(client);

      await oracle.observe(pairAddress);
      const result = await oracle.getTWAP(pairAddress);

      expect(result).toBeNull();
    });
  });

  describe('getSpotPrice', () => {
    it('computes spot price from reserves', async () => {
      const pairAddress = 'CBQHNAXSI555GX2GS764XZHGMNO5XSARACTBP44JIPYZRVQ73NPFV';
      const reserve0 = 5000000000n;
      const reserve1 = 10000000000n;

      const client = mockClient({
        getReserves: jest.fn().mockResolvedValue({ reserve0, reserve1 }),
      });

      const oracle = new OracleModule(client);
      const spot = await oracle.getSpotPrice(pairAddress);

      expect(spot.price0Per1).toBe(
        (reserve0 * PRECISION.PRICE_SCALE) / reserve1,
      );
      expect(spot.price1Per0).toBe(
        (reserve1 * PRECISION.PRICE_SCALE) / reserve0,
      );
    });

    it('throws when pool has no liquidity', async () => {
      const pairAddress = 'CBQHNAXSI555GX2GS764XZHGMNO5XSARACTBP44JIPYZRVQ73NPFV';

      const client = mockClient({
        getReserves: jest.fn().mockResolvedValue({
          reserve0: 0n,
          reserve1: 0n,
        }),
      });

      const oracle = new OracleModule(client);
      await expect(oracle.getSpotPrice(pairAddress)).rejects.toThrow(
        InsufficientLiquidityError,
      );
    });
  });

  describe('clearCache', () => {
    it('clears observations for a specific pair', async () => {
      const pairAddress = 'CBQHNAXSI555GX2GS764XZHGMNO5XSARACTBP44JIPYZRVQ73NPFV';

      const client = mockClient({
        getCumulativePrices: jest.fn().mockResolvedValue({
          price0CumulativeLast: 100000000n,
          price1CumulativeLast: 200000000n,
          blockTimestampLast: 1000,
        }),
      });

      const oracle = new OracleModule(client);
      await oracle.observe(pairAddress);
      expect(oracle.getObservationCount(pairAddress)).toBe(1);

      oracle.clearCache(pairAddress);
      expect(oracle.getObservationCount(pairAddress)).toBe(0);
    });
  });
});
