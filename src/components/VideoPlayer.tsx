import { useEffect, useRef } from 'react';
import { attachLivePlayer } from '../media/live-player';
import type { LiveTransport } from '../media/live-transport.js';
import { AspectRatio, Box, Center, Paper, Text } from '@mantine/core';

export function VideoPlayer({
  stream,
  reportError,
  recoverPlayback,
}: {
  stream: LiveTransport | null;
  reportError: (message: string) => void;
  recoverPlayback: (stream: LiveTransport, message: string) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    element.defaultMuted = false;
    element.muted = false;
    if (stream) {
      try {
        return attachLivePlayer(element, stream, reportError, (message) =>
          recoverPlayback(stream, message),
        );
      } catch (error) {
        queueMicrotask(() => reportError(error instanceof Error ? error.message : String(error)));
        return;
      }
    }
    element.pause();
    element.removeAttribute('src');
    element.load();
  }, [stream, reportError, recoverPlayback]);
  return (
    <Paper withBorder style={{ overflow: 'hidden' }}>
      <AspectRatio ratio={16 / 9} bg="black" pos="relative">
        <Box
          component="video"
          ref={video}
          controls={!!stream}
          w="100%"
          h="100%"
          style={{
            display: 'block',
            objectFit: 'contain',
            visibility: stream ? 'visible' : 'hidden',
          }}
          playsInline
          aria-label="Television playback"
        />
        {!stream && (
          <Center pos="absolute" inset={0} c="white" style={{ pointerEvents: 'none' }}>
            <Text size="sm">No signal</Text>
          </Center>
        )}
      </AspectRatio>
    </Paper>
  );
}
