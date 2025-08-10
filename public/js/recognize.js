const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
const thresholdInput = document.getElementById('threshold');
const logs = document.getElementById('logs');
const statusEl = document.getElementById('status');
const fpsDisplay = document.getElementById('fpsDisplay');
const latencyDisplay = document.getElementById('latencyDisplay');
const faceCountDisplay = document.getElementById('faceCountDisplay');
const logCounter = document.getElementById('logCounter');
const clearLogsBtn = document.getElementById('clearLogs');

let dpr = window.devicePixelRatio || 1;
let lastTs = performance.now();
let fpsHistory = [];
let recognitionHistory = [];
let isRunning = false;

const CV_RECOGNIZE = '/cv/recognize';

async function setupCamera() {
  try {
    statusEl.innerHTML = '<span class="loading"></span> 正在启动摄像头...';
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    video.srcObject = stream;
    await new Promise(r => (video.onloadedmetadata = r));
    syncCanvasSize();
    statusEl.textContent = '✅ 摄像头就绪，开始识别...';
    statusEl.style.background = 'rgba(16, 185, 129, 0.1)';
    statusEl.style.color = '#10b981';
    isRunning = true;
  } catch (error) {
    statusEl.textContent = '❌ 无法访问摄像头，请检查权限设置';
    statusEl.style.background = 'rgba(239, 68, 68, 0.1)';
    statusEl.style.color = '#ef4444';
  }
}

function syncCanvasSize() {
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  // CSS size
  video.width = w;
  video.height = h;
  overlay.style.width = w + 'px';
  overlay.style.height = h + 'px';
  // Device pixel ratio for crisp drawing
  dpr = window.devicePixelRatio || 1;
  overlay.width = Math.round(w * dpr);
  overlay.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', syncCanvasSize);

function snapshotDataUrl() {
  const c = document.createElement('canvas');
  // 下采样至最大高度 480，降低网络传输体积
  const maxH = 480;
  const scale = Math.min(1, maxH / (video.videoHeight || maxH));
  c.width = Math.round((video.videoWidth || 640) * scale);
  c.height = Math.round((video.videoHeight || 480) * scale);
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  // 使用 webp 获得更小体积（兼容性较好）
  return { data: c.toDataURL('image/webp', 0.7), scale };
}

function logRecognition(results) {
  if (!results || results.length === 0) return;
  
  const timestamp = new Date().toLocaleTimeString();
  results.forEach(result => {
    if (result.name !== '未知') {
      const entry = {
        name: result.name,
        confidence: result.confidence,
        timestamp: timestamp
      };
      
      // 避免重复记录同一人连续识别
      const lastEntry = recognitionHistory[0];
      if (!lastEntry || lastEntry.name !== entry.name || 
          (performance.now() - lastEntry.time) > 2000) {
        
        entry.time = performance.now();
        recognitionHistory.unshift(entry);
        
        // 限制记录数量
        if (recognitionHistory.length > 50) {
          recognitionHistory.pop();
        }
        
        // 添加到DOM
        const li = document.createElement('li');
        li.innerHTML = `
          <div style="display: flex; align-items: center; justify-content: space-between;">
            <div>
              <strong style="color: #10b981;">👤 ${entry.name}</strong>
              <span style="font-size: 12px; color: #6b7280; margin-left: 8px;">
                置信度: ${entry.confidence.toFixed(2)}
              </span>
            </div>
            <span style="font-size: 12px; color: #6b7280;">
              ${entry.timestamp}
            </span>
          </div>
        `;
        
        // 添加进入动画
        li.style.opacity = '0';
        li.style.transform = 'translateX(-20px)';
        logs.prepend(li);
        
        setTimeout(() => {
          li.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
          li.style.opacity = '1';
          li.style.transform = 'translateX(0)';
        }, 10);
        
        updateLogCounter();
      }
    }
  });
}

function updateLogCounter() {
  const count = recognitionHistory.length;
  logCounter.textContent = count > 0 ? `共 ${count} 条记录` : '暂无记录';
}

function updateStats(latency, faceCount) {
  // FPS 计算
  const now = performance.now();
  const fps = 1000 / (now - lastTs);
  lastTs = now;
  
  fpsHistory.push(fps);
  if (fpsHistory.length > 10) {
    fpsHistory.shift();
  }
  
  const avgFps = fpsHistory.reduce((a, b) => a + b, 0) / fpsHistory.length;
  fpsDisplay.textContent = Math.round(avgFps);
  
  // 延迟显示
  latencyDisplay.textContent = Math.round(latency);
  
  // 人脸数量
  faceCountDisplay.textContent = faceCount;
  
  // 根据性能调整状态
  if (avgFps < 15) {
    statusEl.textContent = '⚠️ 帧率较低，建议优化环境';
    statusEl.style.background = 'rgba(245, 158, 11, 0.1)';
    statusEl.style.color = '#f59e0b';
  } else if (isRunning) {
    statusEl.textContent = '✅ 识别中...';
    statusEl.style.background = 'rgba(16, 185, 129, 0.1)';
    statusEl.style.color = '#10b981';
  }
}

async function renderLoop() {
  if (!isRunning) return;
  
  const start = performance.now();
  let latency = 0;
  let faceCount = 0;
  
  try {
    const snap = snapshotDataUrl();
const image_base64 = snap.data;
const scale = snap.scale;
    const netStart = performance.now();
    
    const res = await fetch(CV_RECOGNIZE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image_base64, threshold: parseFloat(thresholdInput.value) || undefined })
    });
    
    const data = await res.json();
    latency = performance.now() - netStart;
    
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    
    if (res.ok && data.ok && data.result) {
      faceCount = data.result.length;
      
      data.result.forEach(r => {
        const [sx, sy, sw, sh] = r.rect;
        // 由于后端是在下采样后的图上检测，这里需要按 scale 还原到原视频尺寸
        const x = Math.round(sx / (scale || 1));
        const y = Math.round(sy / (scale || 1));
        const w = Math.round(sw / (scale || 1));
        const h = Math.round(sh / (scale || 1));
        
        // 绘制人脸框 - 根据识别结果改变颜色
        const isKnown = r.name !== '未知';
        ctx.strokeStyle = isKnown ? '#22c55e' : '#f59e0b';
        ctx.lineWidth = 3;
        ctx.strokeRect(x, y, w, h);
        
        // 添加发光效果
        ctx.shadowColor = ctx.strokeStyle;
        ctx.shadowBlur = 10;
        ctx.strokeRect(x, y, w, h);
        ctx.shadowBlur = 0;
        
        // 标签背景和文本
        const conf = r.confidence != null ? r.confidence.toFixed(1) : '-';
        const label = `${r.name} (${conf})`;
        ctx.font = '14px system-ui';
        const textW = ctx.measureText(label).width + 12;
        const tx = x;
        const ty = Math.max(0, y - 25);
        
        // 背景
        ctx.fillStyle = isKnown ? 'rgba(34,197,94,0.9)' : 'rgba(245,158,11,0.9)';
        ctx.fillRect(tx, ty, textW, 20);
        
        // 文字
        ctx.fillStyle = '#fff';
        ctx.fillText(label, tx + 6, ty + 14);
        
        // 添加小图标
        ctx.fillText(isKnown ? '✓' : '?', tx + textW - 16, ty + 14);
      });
      
      // 记录识别结果
      logRecognition(data.result);
    }
    
  } catch (e) {
    // 忽略临时错误
  }
  
  updateStats(latency, faceCount);
  requestAnimationFrame(renderLoop);
}

// 清空记录
clearLogsBtn.addEventListener('click', () => {
  recognitionHistory = [];
  logs.innerHTML = '';
  updateLogCounter();
  
  // 显示清空提示
  const message = document.createElement('div');
  message.style.cssText = `
    text-align: center; 
    color: #6b7280; 
    padding: 20px; 
    font-style: italic;
  `;
  message.textContent = '✨ 记录已清空';
  logs.appendChild(message);
  
  setTimeout(() => {
    if (logs.contains(message)) {
      logs.removeChild(message);
    }
  }, 2000);
});

// 阈值变化提示
thresholdInput.addEventListener('input', () => {
  const value = parseFloat(thresholdInput.value);
  let hint = '';

  if (value <= 60) {
    hint = '非常严格（容易漏认）';
  } else if (value <= 90) {
    hint = '较严格 - 推荐 70~90';
  } else if (value <= 110) {
    hint = '中等 - 默认';
  } else {
    hint = '宽松（容易误认）';
  }

  // 在控制条中显示提示
  const existingHint = document.querySelector('.threshold-hint');
  if (existingHint) {
    existingHint.textContent = hint;
  } else {
    const hintSpan = document.createElement('span');
    hintSpan.className = 'threshold-hint';
    hintSpan.style.cssText = 'font-size: 12px; color: #6b7280; margin-left: 8px;';
    hintSpan.textContent = hint;
    thresholdInput.parentElement.appendChild(hintSpan);
  }
});

// 初始化
(async () => {
  await setupCamera();
  if (isRunning) {
    renderLoop();
  }
})();