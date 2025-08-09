const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
const nameInput = document.getElementById('nameInput');
const captureBtn = document.getElementById('captureBtn');
const statusEl = document.getElementById('status');
const progressSection = document.getElementById('progressSection');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const messageArea = document.getElementById('messageArea');

const CV_REGISTER = '/cv/register';
const SAMPLE_COUNT = 8;
const SAMPLE_INTERVAL_MS = 200;

let dpr = window.devicePixelRatio || 1;

async function setupCamera() {
  try {
    statusEl.innerHTML = '<span class="loading"></span> 正在启动摄像头...';
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } });
    video.srcObject = stream;
    await new Promise(r => (video.onloadedmetadata = r));
    syncCanvasSize();
    statusEl.textContent = '✅ 摄像头就绪，请输入姓名后开始注册';
    statusEl.style.background = 'rgba(16, 185, 129, 0.1)';
    statusEl.style.color = '#10b981';
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
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.92);
}

function showMessage(text, type = 'info') {
  const div = document.createElement('div');
  div.className = type === 'success' ? 'success-message' : 'error-message';
  div.textContent = text;
  messageArea.innerHTML = '';
  messageArea.appendChild(div);
  
  // 自动消失
  setTimeout(() => {
    if (messageArea.contains(div)) {
      div.style.transition = 'opacity 0.3s ease';
      div.style.opacity = '0';
      setTimeout(() => messageArea.removeChild(div), 300);
    }
  }, 4000);
}

function drawCountdown(count) {
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  
  // 绘制倒计时圆环
  const centerX = overlay.width / (2 * dpr);
  const centerY = overlay.height / (2 * dpr);
  const radius = 60;
  
  // 背景圆
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.3)';
  ctx.fill();
  
  // 数字
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 48px system-ui';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(count.toString(), centerX, centerY);
}

captureBtn.addEventListener('click', async () => {
  const name = nameInput.value.trim();
  if (!name) {
    showMessage('请输入姓名', 'error');
    nameInput.focus();
    return;
  }
  
  // 禁用按钮和输入
  captureBtn.disabled = true;
  nameInput.disabled = true;
  progressSection.style.display = 'block';
  
  try {
    // 3秒倒计时
    for (let i = 3; i > 0; i--) {
      progressText.textContent = `准备拍摄... ${i}`;
      drawCountdown(i);
      await new Promise(r => setTimeout(r, 1000));
    }
    
    progressText.textContent = '正在采集人脸数据...';
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    
    const frames = [];
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const progress = ((i + 1) / SAMPLE_COUNT) * 100;
      progressFill.style.width = `${progress}%`;
      progressText.textContent = `采集中... ${i + 1}/${SAMPLE_COUNT}`;
      
      frames.push(snapshotDataUrl());
      
      if (i < SAMPLE_COUNT - 1) {
        await new Promise(r => setTimeout(r, SAMPLE_INTERVAL_MS));
      }
    }
    
    progressText.innerHTML = '<span class="loading"></span> 正在处理和训练模型...';
    
    const res = await fetch(CV_REGISTER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, image_base64: frames })
    });
    
    const data = await res.json();
    
    if (!res.ok || !data.ok) {
      throw new Error(data.detail || '注册失败');
    }
    
    progressFill.style.width = '100%';
    progressText.textContent = '✅ 注册成功！';
    progressText.style.background = 'rgba(16, 185, 129, 0.1)';
    progressText.style.color = '#10b981';
    
    showMessage('🎉 注册成功！已保存 ' + (data.saved?.length || SAMPLE_COUNT) + ' 张人脸样本', 'success');
    
    // 3秒后重置表单
    setTimeout(() => {
      nameInput.value = '';
      nameInput.disabled = false;
      captureBtn.disabled = false;
      captureBtn.textContent = '📸 开始注册';
      progressSection.style.display = 'none';
      progressFill.style.width = '0%';
      progressText.style.background = 'rgba(102, 126, 234, 0.1)';
      progressText.style.color = '#374151';
    }, 3000);
    
  } catch (e) {
    showMessage('❌ ' + (e.message || '注册失败'), 'error');
    
    // 重置状态
    nameInput.disabled = false;
    captureBtn.disabled = false;
    captureBtn.textContent = '📸 开始注册';
    progressSection.style.display = 'none';
    progressFill.style.width = '0%';
  }
});

// 输入框回车监听
nameInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter' && !captureBtn.disabled) {
    captureBtn.click();
  }
});

// 页面加载时设置摄像头
(async () => {
  await setupCamera();
})();