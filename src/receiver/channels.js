export const channels = Array.from({ length: 40 }, (_, index) => {
  const channel = index + 13;
  return { channel, name: `CH ${channel}`, center: 473000000 + index * 6000000 + 1000000 / 7 };
});
