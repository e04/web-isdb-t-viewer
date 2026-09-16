/* oxlint-disable react/no-this-in-sfc -- USB driver constructors are not React components. */
// Copyright 2018 Sandeep Mistry All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

export default function USB(device) {
  this._device = device;
}

USB.prototype.open = async function () {
  await this._device.open();
};

USB.prototype.selectConfiguration = async function (configuration) {
  if (this._device.configuration?.configurationValue !== configuration)
    await this._device.selectConfiguration(configuration);
};

USB.prototype.claimInterface = async function (_interface) {
  await this._device.claimInterface(_interface);
};

USB.prototype.releaseInterface = async function (_interface) {
  await this._device.releaseInterface(_interface);
};

USB.prototype.controlTransfer = async function (ti) {
  if (ti.direction === 'out') {
    const result = await this._device.controlTransferOut(ti, ti.data);
    if (result.status !== 'ok' || result.bytesWritten !== ti.data.byteLength)
      throw new Error(`USB control OUT: ${result.status}, short transfer`);
  } else if (ti.direction === 'in') {
    const result = await this._device.controlTransferIn(ti, ti.length);

    if (result.status !== 'ok' || !result.data || result.data.byteLength < ti.length)
      throw new Error(`USB control IN: ${result.status}, short transfer`);
    return result.data.buffer.slice(
      result.data.byteOffset,
      result.data.byteOffset + result.data.byteLength,
    );
  }
};

USB.prototype.bulkTransfer = async function (ti) {
  const result = await this._device.transferIn(ti.endpoint, ti.length);

  if (result.status !== 'ok' || !result.data || !result.data.byteLength)
    throw new Error(`USB bulk IN: ${result.status}`);
  return result.data.buffer.slice(
    result.data.byteOffset,
    result.data.byteOffset + result.data.byteLength,
  );
};

USB.prototype.close = async function () {
  await this._device.close();
};

USB.requestDevice = async function (filters) {
  const usbDevice = await navigator.usb.requestDevice({
    filters: filters,
  });

  return new USB(usbDevice);
};

USB.getDevices = async function (filters) {
  const usbDevices = await navigator.usb.getDevices();
  const devices = [];

  usbDevices.forEach((usbDevice) => {
    filters.forEach((filter) => {
      if (filter.vendorId === usbDevice.vendorId && filter.productId === usbDevice.productId) {
        devices.push(new USB(usbDevice));
      }
    });
  });

  return devices;
};
