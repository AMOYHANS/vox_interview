# voices/ —— VoxCPM 克隆音色参考音频（可选）

把**面试官的克隆样本**放到本目录，命名 `音色名.wav`（例如 `linyue.wav`、`fenge.wav`、`liangzi.wav`）。

要求：
- 单声道、16kHz 或 48kHz WAV（其他采样率会自动重采样）
- 3~10 秒清晰人声（无背景噪音、无音乐），语气平稳
- 一个文件 = 一个面试官音色

配置（`speech/config.json`）：

```json
"tts_voxcpm": {
  "enabled": true,
  "model": "openbmb/VoxCPM2",
  "device": "cpu",
  "voices_dir": "voices",
  "ref_texts": {
    "linyue": "这段音频里的台词原文粘贴到这里（可选，强烈建议填写以提高克隆相似度）"
  }
}
```

安装：`setup_speech.bat --with-voxcpm`，然后在页面「语音合成(TTS)」里选择「本地克隆音色」。

> ⚠️ CPU 上 VoxCPM 合成远慢于实时（一小段需要几十秒）。日常实时面试建议保持
> Edge TTS（秒回），克隆音色适合需要高度定制音色的场景或 GPU 机器。
