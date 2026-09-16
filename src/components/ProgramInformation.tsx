import { useEffect, useState } from 'react';
import { Paper, Stack, Text } from '@mantine/core';
import type { ProgramEvent, ProgramInformation as Information } from '../receiver/receiver.js';

const dateTime = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const time = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  hour: '2-digit',
  minute: '2-digit',
});
function schedule(event: ProgramEvent) {
  if (event.start == null) return '-';
  return `${dateTime.format(event.start)} – ${event.end == null ? '-' : time.format(event.end)} JST`;
}
export function ProgramInformation({
  information,
  running,
}: {
  information: Information | null;
  running: boolean;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 10000);
    return () => window.clearInterval(timer);
  }, [running]);
  const current = information?.current;
  const active = current && (current.end == null || current.end > now) ? current : null;
  const next = information?.next;
  return (
    <Paper withBorder p="md" aria-label="Station and program information">
      <Stack gap="xs">
        <Text fw={600} style={{ overflowWrap: 'anywhere' }}>
          {information?.stationName || '-'}
        </Text>
        <Text fw={500} style={{ overflowWrap: 'anywhere' }}>
          {active?.title || '-'}
        </Text>
        {active && (
          <Text size="sm" c="dimmed">
            {schedule(active)}
          </Text>
        )}
        {active?.description && (
          <Text size="sm" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {active.description}
          </Text>
        )}
        {next && (next.end == null || next.end > now) && (
          <Text size="sm" c="dimmed" mt="xs" style={{ overflowWrap: 'anywhere' }}>
            Next: {next.title || '-'} · {schedule(next)}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
