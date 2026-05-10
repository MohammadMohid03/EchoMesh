import * as Y from 'yjs';

// ── Stroke types ────────────────────────────────────────────────────

export type Tool = 'pen' | 'line' | 'rect' | 'circle' | 'eraser';

export interface Stroke {
  id: string;
  tool: Tool;
  points: number[];    // [x1,y1, x2,y2, ...]
  color: string;
  width: number;
  userId: string;
}

// ── Toolbar config ──────────────────────────────────────────────────

const TOOLS: { id: Tool; icon: string; label: string }[] = [
  { id: 'pen',    icon: '✏️', label: 'Pen' },
  { id: 'line',   icon: '📏', label: 'Line' },
  { id: 'rect',   icon: '⬜', label: 'Rectangle' },
  { id: 'circle', icon: '⭕', label: 'Circle' },
  { id: 'eraser', icon: '🧹', label: 'Eraser' },
];

const COLORS = [
  '#ffffff', '#ff6b6b', '#ffa502', '#fdcb6e', '#00b894',
  '#00cec9', '#6c5ce7', '#e84393', '#0984e3', '#a29bfe',
];

const WIDTHS = [2, 4, 6, 10, 16];

/**
 * Collaborative whiteboard backed by Yjs Y.Array.
 *
 * Each stroke is an object in a shared Y.Array. Drawing locally
 * appends strokes; remote changes trigger a full re-render.
 * The canvas is resolution-aware (handles devicePixelRatio).
 */
export class CollabWhiteboard {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private ystrokes: Y.Array<Stroke>;
  private doc: Y.Doc;

  // Drawing state
  private drawing = false;
  private currentPoints: number[] = [];
  private tool: Tool = 'pen';
  private color = '#ffffff';
  private strokeWidth = 4;
  private userId: string;

  // UI elements
  private toolbar!: HTMLElement;

  // Observer reference for cleanup
  private observer: ((event: Y.YArrayEvent<Stroke>) => void) | null = null;

  constructor(doc: Y.Doc, userId: string) {
    this.doc = doc;
    this.userId = userId;
    this.ystrokes = doc.getArray<Stroke>('whiteboard');
  }

  /** Mount the whiteboard into a container element. */
  mount(container: HTMLElement): void {
    container.innerHTML = '';

    // Create toolbar
    this.toolbar = document.createElement('div');
    this.toolbar.className = 'wb-toolbar';
    this.toolbar.innerHTML = this.renderToolbar();
    container.appendChild(this.toolbar);
    this.wireToolbar();

    // Create canvas wrapper (for overflow)
    const canvasWrap = document.createElement('div');
    canvasWrap.className = 'wb-canvas-wrap';
    container.appendChild(canvasWrap);

    // Create canvas
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wb-canvas';
    canvasWrap.appendChild(this.canvas);

    this.ctx = this.canvas.getContext('2d')!;
    this.resizeCanvas();

    // ── Event listeners ──────────────────────────────────────────
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerUp);
    window.addEventListener('resize', this.onResize);

    // ── Observe Yjs array for remote changes ─────────────────────
    this.observer = () => this.render();
    this.ystrokes.observe(this.observer);

    // Initial render
    this.render();
  }

  // ── Toolbar ───────────────────────────────────────────────────────

  private renderToolbar(): string {
    const tools = TOOLS.map(t =>
      `<button class="wb-tool ${t.id === this.tool ? 'active' : ''}" data-tool="${t.id}" title="${t.label}">${t.icon}</button>`
    ).join('');

    const colors = COLORS.map(c =>
      `<button class="wb-color ${c === this.color ? 'active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></button>`
    ).join('');

    const widths = WIDTHS.map(w =>
      `<button class="wb-width ${w === this.strokeWidth ? 'active' : ''}" data-width="${w}" title="${w}px">
        <span class="wb-width-dot" style="width:${w}px;height:${w}px"></span>
      </button>`
    ).join('');

    return `
      <div class="wb-tool-group">${tools}</div>
      <div class="wb-separator"></div>
      <div class="wb-tool-group">${colors}</div>
      <div class="wb-separator"></div>
      <div class="wb-tool-group">${widths}</div>
      <div class="wb-separator"></div>
      <button class="wb-clear" title="Clear all">🗑️ Clear</button>
    `;
  }

  private wireToolbar(): void {
    this.toolbar.querySelectorAll('.wb-tool').forEach(btn => {
      btn.addEventListener('click', () => {
        this.tool = (btn as HTMLElement).dataset.tool as Tool;
        this.refreshToolbar();
      });
    });

    this.toolbar.querySelectorAll('.wb-color').forEach(btn => {
      btn.addEventListener('click', () => {
        this.color = (btn as HTMLElement).dataset.color!;
        this.refreshToolbar();
      });
    });

    this.toolbar.querySelectorAll('.wb-width').forEach(btn => {
      btn.addEventListener('click', () => {
        this.strokeWidth = Number((btn as HTMLElement).dataset.width);
        this.refreshToolbar();
      });
    });

    this.toolbar.querySelector('.wb-clear')?.addEventListener('click', () => {
      this.doc.transact(() => {
        this.ystrokes.delete(0, this.ystrokes.length);
      });
    });
  }

  private refreshToolbar(): void {
    this.toolbar.innerHTML = this.renderToolbar();
    this.wireToolbar();
  }

  // ── Canvas sizing ─────────────────────────────────────────────────

  private resizeCanvas = (): void => {
    const wrap = this.canvas.parentElement!;
    const dpr = window.devicePixelRatio || 1;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.scale(dpr, dpr);
    this.render();
  };

  private onResize = (): void => {
    this.resizeCanvas();
  };

  // ── Pointer handlers ──────────────────────────────────────────────

  private getPos(e: PointerEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  private onPointerDown = (e: PointerEvent): void => {
    this.drawing = true;
    this.canvas.setPointerCapture(e.pointerId);
    const [x, y] = this.getPos(e);
    this.currentPoints = [x, y];

    // For pen/eraser, start drawing immediately
    if (this.tool === 'pen' || this.tool === 'eraser') {
      this.render();
      this.drawLiveStroke();
    }
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (!this.drawing) return;
    const [x, y] = this.getPos(e);

    if (this.tool === 'pen' || this.tool === 'eraser') {
      this.currentPoints.push(x, y);
      this.render();
      this.drawLiveStroke();
    } else {
      // For shapes, just update the end point
      this.currentPoints = [this.currentPoints[0], this.currentPoints[1], x, y];
      this.render();
      this.drawLiveStroke();
    }
  };

  private onPointerUp = (_e: PointerEvent): void => {
    if (!this.drawing) return;
    this.drawing = false;

    if (this.currentPoints.length >= 4 || (this.tool === 'pen' && this.currentPoints.length >= 2)) {
      const stroke: Stroke = {
        id: crypto.randomUUID(),
        tool: this.tool,
        points: [...this.currentPoints],
        color: this.tool === 'eraser' ? '#0c0e14' : this.color,
        width: this.tool === 'eraser' ? this.strokeWidth * 4 : this.strokeWidth,
        userId: this.userId,
      };
      this.ystrokes.push([stroke]);
    }
    this.currentPoints = [];
  };

  // ── Rendering ─────────────────────────────────────────────────────

  /** Full re-render from Y.Array state. */
  private render(): void {
    const w = this.canvas.width / (window.devicePixelRatio || 1);
    const h = this.canvas.height / (window.devicePixelRatio || 1);

    this.ctx.clearRect(0, 0, w, h);

    // Draw all committed strokes
    const strokes = this.ystrokes.toArray();
    for (const stroke of strokes) {
      this.drawStroke(stroke);
    }
  }

  /** Draw the currently-being-drawn stroke (preview). */
  private drawLiveStroke(): void {
    if (this.currentPoints.length < 2) return;
    const preview: Stroke = {
      id: '',
      tool: this.tool,
      points: this.currentPoints,
      color: this.tool === 'eraser' ? '#0c0e14' : this.color,
      width: this.tool === 'eraser' ? this.strokeWidth * 4 : this.strokeWidth,
      userId: this.userId,
    };
    this.drawStroke(preview);
  }

  private drawStroke(s: Stroke): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const pts = s.points;

    switch (s.tool) {
      case 'pen':
      case 'eraser': {
        if (pts.length < 4) {
          // Single dot
          ctx.beginPath();
          ctx.arc(pts[0], pts[1], s.width / 2, 0, Math.PI * 2);
          ctx.fill();
        } else {
          ctx.beginPath();
          ctx.moveTo(pts[0], pts[1]);
          for (let i = 2; i < pts.length; i += 2) {
            ctx.lineTo(pts[i], pts[i + 1]);
          }
          ctx.stroke();
        }
        break;
      }
      case 'line': {
        if (pts.length >= 4) {
          ctx.beginPath();
          ctx.moveTo(pts[0], pts[1]);
          ctx.lineTo(pts[2], pts[3]);
          ctx.stroke();
        }
        break;
      }
      case 'rect': {
        if (pts.length >= 4) {
          const x = Math.min(pts[0], pts[2]);
          const y = Math.min(pts[1], pts[3]);
          const w = Math.abs(pts[2] - pts[0]);
          const h = Math.abs(pts[3] - pts[1]);
          ctx.strokeRect(x, y, w, h);
        }
        break;
      }
      case 'circle': {
        if (pts.length >= 4) {
          const cx = (pts[0] + pts[2]) / 2;
          const cy = (pts[1] + pts[3]) / 2;
          const rx = Math.abs(pts[2] - pts[0]) / 2;
          const ry = Math.abs(pts[3] - pts[1]) / 2;
          ctx.beginPath();
          ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        break;
      }
    }
    ctx.restore();
  }

  /** Public method to force canvas resize (e.g. when tab becomes visible). */
  resize(): void {
    this.resizeCanvas();
  }

  /** Get the stroke count. */
  get strokeCount(): number {
    return this.ystrokes.length;
  }

  /** Export the canvas as a PNG data URL. */
  toDataURL(): string {
    return this.canvas.toDataURL('image/png');
  }

  /** Clean up. */
  destroy(): void {
    if (this.observer) {
      this.ystrokes.unobserve(this.observer);
    }
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointerleave', this.onPointerUp);
    window.removeEventListener('resize', this.onResize);
  }
}
