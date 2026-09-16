import test from 'node:test';
import assert from 'node:assert/strict';
import USB from '../src/radio/web-usb.js';
import RtlCom from '../src/radio/rtlcom.js';
import RtlSdr from '../src/radio/rtlsdr.js';

test('USB IN respects DataView offsets and rejects stalls', async () => {
  const buffer = new Uint8Array([9, 1, 2, 3, 4, 9]);
  const usb = new USB({
    transferIn: async () => ({ status: 'ok', data: new DataView(buffer.buffer, 1, 4) }),
  });
  assert.deepEqual(
    new Uint8Array(await usb.bulkTransfer({ endpoint: 1, length: 4 })),
    new Uint8Array([1, 2, 3, 4]),
  );
  usb._device.transferIn = async () => ({ status: 'stall', data: null });
  await assert.rejects(usb.bulkTransfer({ endpoint: 1, length: 4 }), /stall/);
});
test('USB OUT rejects short writes; low-level reads propagate errors', async () => {
  const usb = new USB({ controlTransferOut: async () => ({ status: 'ok', bytesWritten: 0 }) });
  await assert.rejects(
    usb.controlTransfer({ direction: 'out', data: new ArrayBuffer(1) }),
    /short transfer/,
  );
  const com = new RtlCom({
    controlTransfer: async () => {
      throw new Error('Disconnected');
    },
  });
  await assert.rejects(com.i2c.readRegBuffer(0x34, 0, 3), /USB write failed|USB read failed/);
});
test('close releases USB even when tuner shutdown fails', async () => {
  let closed = false;
  const sdr = new RtlSdr({
    close: async () => {
      closed = true;
    },
  });
  sdr._rtl2832u = {
    close: async () => {
      throw new Error('unplugged');
    },
  };
  await assert.rejects(sdr.close(), /unplugged/);
  assert.equal(closed, true);
});
