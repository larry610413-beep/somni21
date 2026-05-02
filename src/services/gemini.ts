import { GoogleGenAI, Modality } from "@google/genai";

const SPEAKER_MAP: Record<string, string> = {
  '小美': 'Callirrhoe',
  '女生': 'Callirrhoe',
  '小明': 'Puck',
  '男生': 'Puck',
  '老師': 'Kore'
};

const VOICE_POOL = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'];
const DEFAULT_VOICE = 'Zephyr';

function createWavBlob(pcmData: Uint8Array, sampleRate = 24000): Blob {
  // Check if it's already a WAV file (starts with RIFF)
  if (pcmData.length > 4 && 
      pcmData[0] === 0x52 && pcmData[1] === 0x49 && 
      pcmData[2] === 0x46 && pcmData[3] === 0x46) {
    return new Blob([pcmData], { type: 'audio/wav' });
  }

  const len = pcmData.length;
  const buffer = new ArrayBuffer(44 + len);
  const view = new DataView(buffer);
  const writeString = (o: number, s: string) => { 
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); 
  };
  writeString(0, 'RIFF'); 
  view.setUint32(4, 36 + len, true); 
  writeString(8, 'WAVE'); 
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true); 
  view.setUint16(20, 1, true); 
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); 
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); 
  view.setUint16(34, 16, true); 
  writeString(36, 'data'); 
  view.setUint32(40, len, true);
  const pcm = new Uint8Array(buffer, 44);
  pcm.set(pcmData);
  return new Blob([buffer], { type: 'audio/wav' });
}

// 各種停頓的靜音長度 (24kHz, 16-bit mono = 2 bytes/sample)
function makeSilence(seconds: number): Uint8Array {
  return new Uint8Array(24000 * seconds * 2);
}

type PauseType = 'comma' | 'sentence' | 'paragraph' | 'none';

interface Chunk {
  text: string;
  pauseAfter: PauseType;
}

export async function generateTTS(text: string, apiKey: string, isSelection: boolean = false, onProgress?: (current: number, total: number) => void): Promise<Blob> {
  const ai = new GoogleGenAI({ apiKey });

  const MAX_CHUNK_SIZE = 400;
  const chunks: Chunk[] = [];

  // 按段落切分後，再按逗點與句號切分
  const nonEmptyParagraphs = text.split('\n').filter(p => p.trim());

  for (let pIdx = 0; pIdx < nonEmptyParagraphs.length; pIdx++) {
    const p = nonEmptyParagraphs[pIdx];
    const isLastParagraph = pIdx === nonEmptyParagraphs.length - 1;

    // 用標點切分，保留分隔符
    // 逗點：，,  句號：。！？!?
    const parts = p.split(/([，,。！？!?])/);

    let currentText = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      const isComma = /^[，,]$/.test(part);
      const isSentence = /^[。！？!?]$/.test(part);

      if (isComma || isSentence) {
        currentText += part;

        // 超過 MAX_CHUNK_SIZE 強制切分，否則在有意義的標點後 flush
        if (currentText.trim()) {
          const pauseAfter: PauseType = isComma ? 'comma' : 'sentence';
          // 短逗號片段（< 10字）先合併到下一個，減少 API 呼叫
          if (isComma && currentText.replace(/[，,\s]/g, '').length < 10 && i < parts.length - 1) {
            // 繼續累積
          } else {
            chunks.push({ text: currentText.trim(), pauseAfter });
            currentText = '';
          }
        }
      } else {
        // 一般文字
        if (currentText && (currentText + part).length > MAX_CHUNK_SIZE) {
          chunks.push({ text: currentText.trim(), pauseAfter: 'none' });
          currentText = '';
        }
        currentText += part;
      }
    }

    // flush 段落剩餘文字
    if (currentText.trim()) {
      chunks.push({
        text: currentText.trim(),
        pauseAfter: isLastParagraph ? 'none' : 'paragraph',
      });
    } else if (chunks.length > 0 && !isLastParagraph) {
      // 把最後一個 chunk 的停頓升格為段落停頓
      chunks[chunks.length - 1].pauseAfter = 'paragraph';
    }
  }

  if (chunks.length === 0 && text.trim()) {
    chunks.push({ text: text.trim(), pauseAfter: 'none' });
  }

  const audioChunks: Uint8Array[] = [];

  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress(i + 1, chunks.length);

    const chunkText = chunks[i].text.trim();
    const { pauseAfter } = chunks[i];
    if (!chunkText) continue;

    const speakers = new Set<string>();
    chunkText.split('\n').forEach(line => {
      const m = line.match(/^([^：:\s]+)[：:]/);
      if (m) speakers.add(m[1]);
    });

    let processedText = chunkText;
    if (!isSelection) {
      processedText = chunkText.replace(/([。！？!?])/g, '$1 ');
      processedText = processedText.replace(/\n+/g, '\n');
    }

    const finalPrompt = isSelection
      ? `Please pronounce this text clearly and naturally: ${processedText}`
      : processedText;

    const speakerArray = Array.from(speakers);
    let speechConfig: any;

    if (speakerArray.length > 1) {
      speechConfig = {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: speakerArray.map((n, idx) => ({
            speaker: n,
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: SPEAKER_MAP[n] || VOICE_POOL[idx % 5]
              }
            }
          }))
        }
      };
    } else {
      const voiceName = speakerArray.length === 1
        ? (SPEAKER_MAP[speakerArray[0]] || DEFAULT_VOICE)
        : DEFAULT_VOICE;

      speechConfig = {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: voiceName
          }
        }
      };
    }

    try {
      // 增加小延遲以避免 API 頻率限制
      if (i > 0) await new Promise(resolve => setTimeout(resolve, 300));

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-preview-tts",
        contents: [{ parts: [{ text: finalPrompt }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: speechConfig
        },
      });

      if (!response.candidates?.[0]?.content?.parts) {
        throw new Error("API 回應內容為空");
      }

      const audioPart = response.candidates[0].content.parts.find(p => p.inlineData);
      const audioBase64 = audioPart?.inlineData?.data;

      if (!audioBase64) {
        throw new Error("無法獲取音訊資料");
      }

      const binary = atob(audioBase64);
      const bytes = new Uint8Array(binary.length);
      for (let j = 0; j < binary.length; j++) {
        bytes[j] = binary.charCodeAt(j);
      }

      // If it has a RIFF header, strip it so we can safely concatenate raw PCM
      let pcmBytes = bytes;
      if (bytes.length > 44 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
        pcmBytes = bytes.slice(44);
      }

      audioChunks.push(pcmBytes);

      // 插入對應停頓（非最後一段、非選取模式）
      if (!isSelection && i < chunks.length - 1) {
        if (pauseAfter === 'comma')     audioChunks.push(makeSilence(2));
        else if (pauseAfter === 'sentence')  audioChunks.push(makeSilence(3));
        else if (pauseAfter === 'paragraph') audioChunks.push(makeSilence(4));
        // 'none' → 不插靜音
      }
    } catch (err: any) {
      console.error(`Chunk ${i + 1} failed:`, err);
      throw new Error(`第 ${i + 1} 段生成失敗: ${err.message || '未知錯誤'}`);
    }
  }

  if (audioChunks.length === 0) {
    throw new Error("未生成任何音訊片段");
  }

  const totalLength = audioChunks.reduce((acc, chunk) => acc + chunk.length, 0);
  const combinedAudio = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of audioChunks) {
    combinedAudio.set(chunk, offset);
    offset += chunk.length;
  }

  return createWavBlob(combinedAudio);
}
