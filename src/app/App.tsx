import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Box,
  Button,
  Container,
  Grid,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import { Receiver, initialState } from '../receiver/receiver.js';
import { channels } from '../receiver/channels.js';
import { SignalPlot } from '../components/SignalPlot';
import { ProgramInformation } from '../components/ProgramInformation';
import { VideoPlayer } from '../components/VideoPlayer';
import type { LiveTransport } from '../media/live-transport.js';

const channelOptions = channels.map(({ channel, center }) => ({
  value: String(channel),
  label: `CH ${channel} · ${(center / 1e6).toFixed(3)} MHz`,
}));
const gains = [
  0, 0.9, 1.4, 2.7, 3.7, 7.7, 8.7, 12.5, 14.4, 15.7, 16.6, 19.7, 20.7, 22.9, 25.4, 28, 29.7, 32.8,
  33.8, 36.4, 37.2, 38.6, 40.2, 42.1, 43.4, 43.9, 44.5, 48, 49.6,
];
const gainOptions = [
  { value: 'auto', label: 'Auto' },
  ...gains.map((gain) => ({ value: String(gain), label: `${gain.toFixed(1)} dB` })),
];
const format = (value: number | null | undefined, unit = '', decimals = 1) =>
  value != null && Number.isFinite(value) ? `${value.toFixed(decimals)}${unit}` : '—';
function preference(key: string, fallback: string, choices: { value: string }[]) {
  try {
    const value = localStorage.getItem(key);
    return choices.some((choice) => choice.value === value) ? value! : fallback;
  } catch {
    return fallback;
  }
}
function App() {
  const [state, setState] = useState(initialState);
  const [receiver] = useState(() => new Receiver(setState));
  const [channel, setChannel] = useState(() => preference('isdb-channel', '27', channelOptions));
  const [gain, setGain] = useState(() => preference('isdb-gain', '20.7', gainOptions));
  const logs = useRef<HTMLPreElement>(null);
  const followLogs = useRef(true);
  const receptionRequested = useRef(false);
  const configurationVersion = useRef(0);
  const configurationQueue = useRef<Promise<void>>(Promise.resolve());
  const selectedConfiguration = useRef({ channel, gain });
  const supported = window.isSecureContext && 'usb' in navigator;
  const reportPlaybackError = useCallback(
    (message: string) => receiver.logError(message),
    [receiver],
  );
  const recoverPlayback = useCallback(
    (stream: LiveTransport, message: string) => receiver.recoverPlayback(stream, message),
    [receiver],
  );
  useEffect(() => {
    const instance = receiver;
    const unload = () => {
      void instance.stop();
    };
    window.addEventListener('pagehide', unload);
    return () => {
      window.removeEventListener('pagehide', unload);
      void instance.stop();
    };
  }, [receiver]);
  useEffect(() => {
    try {
      localStorage.setItem('isdb-channel', channel);
      localStorage.setItem('isdb-gain', gain);
    } catch {
      /* Private browsing may disallow storage. */
    }
  }, [channel, gain]);
  useEffect(() => {
    if (logs.current && followLogs.current) logs.current.scrollTop = logs.current.scrollHeight;
  }, [state.logs]);
  const actionDisabled = state.busy || state.running;
  const metrics = state.result?.metrics,
    transport = state.result?.transport;
  const queueReception = (restart: boolean) => {
    receptionRequested.current = true;
    const version = ++configurationVersion.current;
    configurationQueue.current = configurationQueue.current.then(async () => {
      if (!receptionRequested.current || version !== configurationVersion.current) return;
      if (restart) await receiver.stop();
      if (!receptionRequested.current || version !== configurationVersion.current) return;
      const { channel: nextChannel, gain: nextGain } = selectedConfiguration.current;
      const nextGainValue = nextGain === 'auto' ? null : Number(nextGain);
      await receiver.connect(nextGainValue);
      if (!receptionRequested.current || version !== configurationVersion.current) {
        await receiver.stop();
        return;
      }
      void receiver.start(Number(nextChannel), nextGainValue);
    });
  };
  const entries = [
    ['Decode time', format(state.decodeMs / 1000, ' s', 2)],
    ['Dropped windows', String(state.dropped)],
    ['Playback recoveries', String(state.recoveries)],
    ['MER', format(metrics?.merDb, ' dB')],
    ['EVM', format(metrics?.evmPercent, '%')],
    ['Carrier offset', format(metrics?.totalCfoHz, ' Hz')],
    ['ADC clipping', format(metrics?.clippedPercent, '%', 3)],
    ['CP correlation', format(metrics?.cpCorrelation, '', 3)],
    ['Pilot coherence', format(metrics?.pilotCoherence, '', 3)],
    ['Guard interval', metrics?.guardRatio || '—'],
    ['Symbols', metrics?.symbols.toLocaleString() || '—'],
    ['RS packets', transport?.validPackets?.toLocaleString() ?? '—'],
    ['RS failures', transport?.failedPackets?.toLocaleString() ?? '—'],
    ['TMCC frames', transport?.tmccFrames?.toLocaleString() ?? '—'],
    [
      'Code rate',
      transport?.parameters
        ? ['1/2', '2/3', '3/4', '5/6', '7/8'][transport.parameters.rateIndex]
        : '—',
    ],
  ];
  return (
    <Container fluid mih="100dvh" px={{ base: 'xs', sm: 'md' }} py="sm">
      <Stack maw={1440} mih="calc(100dvh - var(--mantine-spacing-md))" mx="auto" gap="md">
        {!supported && (
          <Alert title="WebUSB unavailable">Use Chrome or Edge over HTTPS or localhost.</Alert>
        )}
        <Paper withBorder p="md">
          <Group align="end" gap="sm">
            <Select
              label="Physical channel"
              labelProps={{ mb: 'xs' }}
              data={channelOptions}
              value={channel}
              onChange={(value) => {
                if (!value) return;
                selectedConfiguration.current = {
                  ...selectedConfiguration.current,
                  channel: value,
                };
                setChannel(value);
                if (receptionRequested.current) queueReception(true);
              }}
              searchable
              allowDeselect={false}
              flex={1}
              miw={{ base: '100%', xs: 220 }}
            />
            <Select
              label="Tuner gain"
              labelProps={{ mb: 'xs' }}
              data={gainOptions}
              value={gain}
              onChange={(value) => {
                if (!value) return;
                selectedConfiguration.current = { ...selectedConfiguration.current, gain: value };
                setGain(value);
                if (receptionRequested.current) queueReception(true);
              }}
              allowDeselect={false}
              w={140}
            />
            {!state.connected && (
              <Button
                color="dark"
                variant="white"
                disabled={!supported || actionDisabled}
                onClick={() => queueReception(false)}
                loading={state.busy && state.status === 'Connecting'}
              >
                Connect RTL-SDR
              </Button>
            )}
          </Group>
        </Paper>
        <Grid gutter="md">
          <Grid.Col span={{ base: 12, md: 8 }}>
            <Stack gap="md">
              <VideoPlayer
                stream={state.stream}
                reportError={reportPlaybackError}
                recoverPlayback={recoverPlayback}
              />
              <ProgramInformation information={state.programInformation} running={state.running} />
              <Paper withBorder p="md">
                <SimpleGrid
                  component="dl"
                  cols={{ base: 3, sm: 4 }}
                  spacing="xs"
                  verticalSpacing="lg"
                  m={0}
                >
                  {entries.map(([label, value]) => (
                    <Box key={label}>
                      <Text component="dt" size="10px" c="dimmed" mb={5}>
                        {label}
                      </Text>
                      <Text
                        component="dd"
                        size="xs"
                        m={0}
                        ff="monospace"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                      >
                        {value}
                      </Text>
                    </Box>
                  ))}
                  <Box style={{ gridColumn: '1 / -1', minWidth: 0 }}>
                    <Text component="dt" size="10px" c="dimmed" mb={5}>
                      Status
                    </Text>
                    <Text component="dd" size="xs" m={0} style={{ overflowWrap: 'anywhere' }}>
                      {state.status}
                    </Text>
                  </Box>
                </SimpleGrid>
              </Paper>
            </Stack>
          </Grid.Col>
          <Grid.Col span={{ base: 12, md: 4 }}>
            <SimpleGrid cols={{ base: 1, xs: 2, md: 1 }} spacing="md" h="100%">
              <Paper
                withBorder
                style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
              >
                <Group justify="space-between" p="sm">
                  <Text size="xs" c="dimmed">
                    I / Q
                  </Text>
                </Group>
                <SignalPlot result={state.result} />
              </Paper>
              <Paper
                withBorder
                style={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
              >
                <Group justify="space-between" p="sm">
                  <Text size="xs" c="dimmed">
                    dBFS/Hz
                  </Text>
                </Group>
                <SignalPlot result={state.result} spectrum />
              </Paper>
            </SimpleGrid>
          </Grid.Col>
        </Grid>
        <Paper withBorder style={{ overflow: 'hidden' }}>
          <Box
            component="pre"
            ref={logs}
            tabIndex={0}
            aria-label="Receiver log"
            onScroll={(event) => {
              const log = event.currentTarget;
              followLogs.current = log.scrollHeight - log.scrollTop - log.clientHeight <= 1;
            }}
            m={0}
            h={148}
            p="sm"
            bg="dark.9"
            c="dimmed"
            fz={11}
            lh={1.8}
            style={{ overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          >
            {state.logs.length
              ? state.logs.map((line, index) => (
                  <Text
                    component="span"
                    c={line.startsWith('[ERROR] ') ? 'red.5' : undefined}
                    inherit
                    key={`${index}-${line}`}
                  >
                    {line}
                    {'\n'}
                  </Text>
                ))
              : ''}
          </Box>
        </Paper>
      </Stack>
    </Container>
  );
}
export default App;
