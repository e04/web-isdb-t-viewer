import test from 'node:test';
import assert from 'node:assert/strict';
import RTL2832U from '../src/radio/rtl2823u.js';

const I2C_INDEX = 0x600;
const SYS_INDEX = 0x200;
const GPO = 0x3001;
const GPOE = 0x3003;

// Fakes the RTL2832U control endpoint with one R82xx tuner answering at `tunerAddr`.
function fakeDongle({ tunerAddr, manufacturerName, productName }) {
  const regs = new Map();
  const tunerRegs = new Map();
  const tunerAddrsTouched = new Set();
  // Raw (bit-reversed on the wire) status: PLL locked, VCO fine tune = 1.
  const tunerStatus = [0x69, 0x00, 0x02, 0x00, 0x08];
  return {
    manufacturerName,
    productName,
    tunerRegs,
    tunerAddrsTouched,
    sysReg: (reg) => regs.get(`${SYS_INDEX}:${reg}`) ?? 0,
    claimInterface: async () => {},
    releaseInterface: async () => {},
    controlTransfer: async (ti) => {
      const block = ti.index & ~0x10;
      if (block === I2C_INDEX) {
        if (ti.value !== tunerAddr) throw new Error('USB control OUT: stall');
        tunerAddrsTouched.add(ti.value);
        if (ti.direction === 'out') {
          const [reg, value] = new Uint8Array(ti.data);
          if (value !== undefined) tunerRegs.set(reg, value);
          return;
        }
        return new Uint8Array(tunerStatus.concat([0, 0, 0])).buffer.slice(0, ti.length);
      }
      const key = `${block}:${ti.value}`;
      if (ti.direction === 'out') {
        regs.set(key, new Uint8Array(ti.data)[0]);
        return;
      }
      return new Uint8Array([regs.get(key) ?? 0, 0, 0, 0, 0, 0, 0, 0]).buffer;
    },
  };
}

const UHF_CHANNEL_27 = 557142857;

test('RTL-SDR Blog V4: R828D at 0x74 tunes UHF via the Air-In path', async () => {
  const dongle = fakeDongle({
    tunerAddr: 0x74,
    manufacturerName: 'RTLSDRBlog',
    productName: 'Blog V4',
  });
  const rtl = new RTL2832U(dongle, 0, null);
  await rtl.open();
  const actual = await rtl.setCenterFrequency(UHF_CHANNEL_27);

  assert.ok(Math.abs(actual - UHF_CHANNEL_27) < 1000, `tuned to ${actual}`);
  assert.deepEqual([...dongle.tunerAddrsTouched], [0x74]);
  assert.equal(dongle.tunerRegs.get(0x05) & 0x60, 0x00, 'Air-In selected, Cable1 off');
  assert.equal(dongle.tunerRegs.get(0x06) & 0x08, 0x00, 'Cable2 (HF) off');
  assert.equal(dongle.tunerRegs.get(0x17) & 0x08, 0x08, 'notch filters on outside FM/DAB');
  assert.equal(dongle.sysReg(GPOE) & 0x20, 0x20, 'GPIO5 is an output');
  assert.equal(dongle.sysReg(GPO) & 0x20, 0x20, 'GPIO5 high bypasses the HF upconverter');
});

test('R820T dongles keep using 0x34 and never touch GPIO5', async () => {
  const dongle = fakeDongle({
    tunerAddr: 0x34,
    manufacturerName: 'Realtek',
    productName: 'RTL2838UHIDIR',
  });
  const rtl = new RTL2832U(dongle, 0, null);
  await rtl.open();
  const actual = await rtl.setCenterFrequency(UHF_CHANNEL_27);

  assert.ok(Math.abs(actual - UHF_CHANNEL_27) < 1000, `tuned to ${actual}`);
  assert.deepEqual([...dongle.tunerAddrsTouched], [0x34]);
  assert.equal(dongle.sysReg(GPOE) & 0x20, 0);
});

test('dongles with no R82xx tuner are rejected', async () => {
  const dongle = fakeDongle({ tunerAddr: 0x10 });
  await assert.rejects(new RTL2832U(dongle, 0, null).open(), /unsupported tuner chip/);
});
