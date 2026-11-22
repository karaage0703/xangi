import { useEffect, useRef, useState } from 'react';
import { requestJson, sharedReadJson } from './api';
import { jsonInit } from './chatPresentation';
import { saveSubmission } from './conversationTurns';
import { sessionPath } from './sessionPermalink';

const CELL_WIDTH = 192;
const CELL_HEIGHT = 208;
const COLUMNS = 8;
const ROWS = 9;
const FRAME_DELAY = 1000 / 6;

type Sprite = { status: 'ready'; enabled: true; name: string; imageUrl: string };
type Pet = Sprite | { status: 'hidden' | 'missing' | 'invalid'; enabled: boolean };
type Pose = 'idle' | 'thinking' | 'talking';

const poseRows: Record<Pose, number> = { idle: 0, thinking: 8, talking: 3 };
const petEndpoint = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/pet`;

export const agentSettingsPath = (agentId: string) =>
  `/settings?${new URLSearchParams({ agent: agentId })}#agents`;

function SpriteCanvas({ pet, pose = 'idle' }: { pet: Sprite; pose?: Pose }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const poseRef = useRef(pose);
  poseRef.current = pose;
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const image = new Image();
    let timer: number | undefined;
    let frames: number[][] = [];
    let previousRow = -1;
    let step = 0;

    const draw = () => {
      const row = poseRows[poseRef.current];
      if (row !== previousRow) step = 0;
      previousRow = row;
      const columns = frames[row].length ? frames[row] : frames[0];
      const column = columns[step % columns.length];
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(
        image,
        column * CELL_WIDTH,
        (frames[row].length ? row : 0) * CELL_HEIGHT,
        CELL_WIDTH,
        CELL_HEIGHT,
        0,
        0,
        canvas.width,
        canvas.height
      );
      step++;
    };
    const updateMotion = () => {
      window.clearInterval(timer);
      if (!frames[0]?.length || document.hidden) return;
      step = 0;
      draw();
      if (!motion.matches) timer = window.setInterval(draw, FRAME_DELAY);
    };

    image.onload = () => {
      if (image.naturalWidth !== CELL_WIDTH * COLUMNS || image.naturalHeight !== CELL_HEIGHT * ROWS)
        return;
      const source = document.createElement('canvas');
      source.width = image.naturalWidth;
      source.height = image.naturalHeight;
      const reader = source.getContext('2d', { willReadFrequently: true });
      if (!reader) return;
      reader.drawImage(image, 0, 0);
      const pixels = reader.getImageData(0, 0, source.width, source.height).data;
      frames = Array.from({ length: ROWS }, (_, row) => {
        const filled = [];
        for (let column = 0; column < COLUMNS; column++) {
          const left = column * CELL_WIDTH;
          const top = row * CELL_HEIGHT;
          let visible = false;
          for (let y = top; y < top + CELL_HEIGHT && !visible; y++) {
            for (let x = left; x < left + CELL_WIDTH; x++) {
              if (pixels[(y * source.width + x) * 4 + 3] > 5) {
                visible = true;
                break;
              }
            }
          }
          if (visible) filled.push(column);
        }
        return filled;
      });
      if (!frames[0].length) return;
      updateMotion();
      setLoaded(true);
    };
    motion.addEventListener('change', updateMotion);
    document.addEventListener('visibilitychange', updateMotion);
    image.src = pet.imageUrl;
    return () => {
      image.onload = null;
      window.clearInterval(timer);
      motion.removeEventListener('change', updateMotion);
      document.removeEventListener('visibilitychange', updateMotion);
    };
  }, [pet.imageUrl]);

  return (
    <canvas
      className="agent-pet"
      ref={canvasRef}
      width={CELL_WIDTH}
      height={CELL_HEIGHT}
      role="img"
      aria-label={pet.name}
      title={pet.name}
      hidden={!loaded}
    />
  );
}

export function ConversationPet({
  agentId,
  pose,
  revision,
}: {
  agentId: string;
  pose: Pose;
  revision?: string;
}) {
  const [pet, setPet] = useState<Pet>();
  useEffect(() => {
    let current = true;
    const refresh = () =>
      void sharedReadJson<Pet>(petEndpoint(agentId)).then(
        (result) => {
          if (current) setPet(result);
        },
        () => {
          if (current) setPet(undefined);
        }
      );
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      current = false;
      window.removeEventListener('focus', refresh);
    };
  }, [agentId, revision]);
  return pet?.status === 'ready' ? <SpriteCanvas key={pet.imageUrl} pet={pet} pose={pose} /> : null;
}

export function AgentPetSettings({
  agentId,
  workspaceChanged,
}: {
  agentId: string;
  workspaceChanged: boolean;
}) {
  const [pet, setPet] = useState<Pet>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const endpoint = petEndpoint(agentId);

  useEffect(() => {
    const abort = new AbortController();
    void requestJson<Pet>(endpoint, { signal: abort.signal }).then(setPet, (cause: unknown) => {
      if (!abort.signal.aborted) setError(String(cause));
    });
    return () => abort.abort();
  }, [endpoint]);

  async function setEnabled(enabled: boolean) {
    const previous = pet;
    setPending(true);
    setError('');
    setPet({ enabled, status: 'hidden' });
    try {
      await requestJson(endpoint, jsonInit('PATCH', { enabled }));
    } catch (cause) {
      setPet(previous);
      setError(String(cause));
      setPending(false);
      return;
    }
    try {
      if (enabled) setPet(await requestJson<Pet>(endpoint));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setPending(false);
    }
  }

  async function createPet() {
    setPending(true);
    setError('');
    try {
      const { sessionId, requestId, message } = await requestJson<{
        sessionId: string;
        requestId: string;
        message: string;
      }>(`${endpoint}/create`, { method: 'POST' });
      try {
        saveSubmission(sessionId, { requestId, message, files: [], accepted: true });
      } catch {
        // The server already owns the turn even when the browser blocks sessionStorage.
      }
      window.location.assign(sessionPath(sessionId));
    } catch (cause) {
      setError(String(cause));
      setPending(false);
    }
  }

  return (
    <fieldset className="agent-pet-settings">
      <legend>ペット</legend>
      <label>
        <input
          type="checkbox"
          checked={pet?.enabled ?? true}
          disabled={!pet || pending}
          onChange={(event) => void setEnabled(event.target.checked)}
        />
        会話にペットを表示
      </label>
      <small>表示設定はすぐに保存されます。</small>
      {pet?.status === 'ready' && <SpriteCanvas key={pet.imageUrl} pet={pet} />}
      {pet?.status === 'invalid' && (
        <p role="status">ワークスペースのペット素材を確認してください。</p>
      )}
      {pet?.status === 'missing' && (
        <div className="agent-pet-create">
          <p role="status">
            {workspaceChanged
              ? 'ペットを作るワークスペースを先に保存してください。'
              : 'ペットがまだいません。xangi に作ってもらいますか？'}
          </p>
          <button
            type="button"
            disabled={pending || workspaceChanged}
            onClick={() => void createPet()}
          >
            作成を依頼
          </button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
