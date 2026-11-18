// Test mode (open the page with ?sim). Instead of the real camera, this
// renders what a camera would see: a dim wall with paintings, lit by whatever
// the app is "projecting" on the #out canvas, warped through a known
// perspective, delayed like Miracast, with sensor noise. It lets the
// calibration be tested end to end on a computer.
import { loadOpenCV } from './cv.js';

export async function startSim() {
  const cv = await loadOpenCV();
  const W = 1280;
  const H = 720;
  const out = document.getElementById('out');

  const cam = document.createElement('canvas');
  cam.width = W; cam.height = H;
  const g = cam.getContext('2d');
  const light = document.createElement('canvas');
  light.width = W; light.height = H;
  const lg = light.getContext('2d');
  const warped = document.createElement('canvas');
  const wall = makeWall(W, H);
  const noise = makeNoise(256);

  // Where the four corners of the phone screen land in the camera image.
  const quad = [[250, 150], [1040, 95], [1085, 600], [215, 565]];
  const truth = { quad, latency: 220, W, H, H: null, snap: null };
  window.__sim = truth;

  const SNAP_W = 960;
  const ring = [];
  let Hm = null;
  let key = '';

  function updateH(sw, sh) {
    const k = sw + 'x' + sh;
    if (k === key) return;
    key = k;
    Hm?.delete();
    const src = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, sw, 0, sw, sh, 0, sh]);
    const dst = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat());
    Hm = cv.getPerspectiveTransform(src, dst);
    src.delete(); dst.delete();
    truth.H = Array.from(Hm.data64F);
    truth.snap = [sw, sh];
  }

  function frame() {
    const now = performance.now();
    const sw = SNAP_W;
    const sh = Math.max(1, Math.round((SNAP_W * out.height) / out.width));
    const snap = ring.length > 14 ? ring.shift().c : document.createElement('canvas');
    if (snap.width !== sw || snap.height !== sh) { snap.width = sw; snap.height = sh; }
    snap.getContext('2d').drawImage(out, 0, 0, sw, sh);
    ring.push({ t: now, c: snap });
    let pick = ring[0];
    for (const r of ring) if (now - r.t >= truth.latency) pick = r;
    updateH(sw, sh);

    const src = cv.imread(pick.c);
    const dst = new cv.Mat();
    cv.warpPerspective(src, dst, Hm, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 255));
    cv.imshow(warped, dst);
    src.delete(); dst.delete();

    // Light falling on the wall: dim room + projector black level + projection.
    lg.globalCompositeOperation = 'source-over';
    lg.fillStyle = 'rgb(46, 44, 40)';
    lg.fillRect(0, 0, W, H);
    lg.globalCompositeOperation = 'lighter';
    lg.fillStyle = 'rgb(9, 9, 9)';
    lg.beginPath();
    quad.forEach(([x, y], i) => (i ? lg.lineTo(x, y) : lg.moveTo(x, y)));
    lg.fill();
    lg.drawImage(warped, 0, 0);

    // What the camera records: surface colour × light, plus noise.
    g.globalCompositeOperation = 'source-over';
    g.drawImage(wall, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.drawImage(light, 0, 0);
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.5;
    const ox = Math.random() * 256, oy = Math.random() * 256;
    g.translate(-ox, -oy);
    g.fillStyle = g.createPattern(noise, 'repeat');
    g.fillRect(0, 0, W + 256, H + 256);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  frame();
  setInterval(frame, 33);
  return cam.captureStream(30);
}

function makeNoise(n) {
  const c = document.createElement('canvas');
  c.width = c.height = n;
  const x = c.getContext('2d');
  const img = x.createImageData(n, n);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 26;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  x.putImageData(img, 0, 0);
  return c;
}

function makeWall(W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = 'rgb(206, 200, 190)';
  g.fillRect(0, 0, W, H);
  const poly = (pts, fill) => {
    g.fillStyle = fill;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
    g.closePath();
    g.fill();
  };
  // Three "paintings", seen at a slight angle.
  const p1 = [[330, 232], [560, 216], [566, 470], [331, 482]];
  const grad = g.createLinearGradient(330, 230, 566, 480);
  grad.addColorStop(0, '#1d3a66');
  grad.addColorStop(0.55, '#b3862f');
  grad.addColorStop(1, '#3a2418');
  poly(p1, grad);
  g.strokeStyle = '#140d09';
  g.lineWidth = 14;
  g.beginPath(); g.moveTo(360, 300); g.bezierCurveTo(420, 260, 470, 420, 540, 330); g.stroke();
  const p2 = [[650, 200], [902, 186], [907, 522], [651, 532]];
  const grad2 = g.createRadialGradient(780, 360, 10, 780, 360, 220);
  grad2.addColorStop(0, '#c8432f');
  grad2.addColorStop(1, '#120a08');
  poly(p2, grad2);
  poly([[950, 300], [1010, 297], [1012, 380], [951, 383]], '#e8dcc4');
  return c;
}
