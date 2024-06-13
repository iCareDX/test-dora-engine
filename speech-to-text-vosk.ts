import * as fs from "fs"
import { RecordingEmitter } from "./recording-emitter"
import { Recorder } from "./voice/recorder"
import { Log } from "~/logger"

import { Model, Recognizer } from "vosk"

const VOICE_RECORDER_ENERGY_POS = process.env["VOICE_RECORDER_ENERGY_POS"] || "2"
const VOICE_RECORDER_ENERGY_NEG = process.env["VOICE_RECORDER_ENERGY_NEG"] || "0.5"
const PRELOAD_COUNT = 3
const SAMPLE_RATE_HERTZ = 16000

const MODEL_PATH = "/home/wanco-dev/.cache/vosk/vosk-model-ja-0.22"

const timestamp = () => {
  const now = new Date()
  return now.getTime()
}

class VOSKSpeechRecordingEmitter extends RecordingEmitter {
  recording = false
  writing = false
  _preloadRecording = false
  recordingTime = 0
  state = "recoding-stop"
  status = ""
  setParams = (any) => {}

  constructor() {
    super()
  }
}

class TimeoutTimer {
  timer: NodeJS.Timeout = null

  clear() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  start(callback: () => void, ms: number) {
    this.clear()
    this.timer = setTimeout(() => {
      this.timer = null
      if (callback) callback()
    }, ms)
  }
}

class SpeechStream {
  stream = null
  filename = null

  isActive() {
    return this.stream != null
  }

  clear() {
    this.stream = null
    this.filename = null
  }
}

function Speech() {
  const speechEmitter = new VOSKSpeechRecordingEmitter()
  const recorder = new Recorder({
    energyThresholdRatioPos: parseFloat(VOICE_RECORDER_ENERGY_POS),
    energyThresholdRatioNeg: parseFloat(VOICE_RECORDER_ENERGY_NEG),
    sampleRate: SAMPLE_RATE_HERTZ,
  })

  const speechStream = new SpeechStream()
  let streamQue = []
 
  const model = new Model(MODEL_PATH)
  const recognizer = new Recognizer({model: model, sampleRate: SAMPLE_RATE_HERTZ})

  const voskSpeechClient = recognizer

  // 認識結果を返す
  const emitResult = (result) => {
    // Log.info(`result ${JSON.stringify(result, null, "  ")}`)
    speechEmitter.emit("data", result)
  }

  // 認識エラーを返す
  const emitError = (err) => {
    const result = {

      errorString: err.toString(),
      transcript: "error",
      confidence: 0,
      payload: "error",
    }
    // Log.info(`error ${JSON.stringify(result, null, "  ")}`)
    speechEmitter.emit("data", result)
  }

  const writing_timer = new TimeoutTimer()

  // 音声検出後、1->2sの遊びを設ける
  const writing_timeout = () => {
    writing_timer.clear()
    if (!speechEmitter.writing) {
      return
    }
    writing_timer.start(() => {
      speechEmitter.writing = false
      if (voskSpeechClient) {
	const result = recognizer.finalResult()
	Log.info(`f_result ${JSON.stringify(result, null, "  ")}`)
	const result_text = result["text"].replace(/\s+/g,'')
	if (result_text) {      
	  emitResult(
	    result_text,
	  )
	}
	//recognizer.reset()

        end_recording(true)
      } else {
        const filename = speechStream.filename
        end_recording()
        emitResult({
          filename,
        })
      }
      Log.info("writing_timeout")
    }, 2000)
  }

  const start_recording = () => {
    recorder.recording = true
    speechEmitter.recording = true
    streamQue = []
  }

  const end_recording = (mode = false) => {
    recorder.recording = false
    if (!mode) {
      speechEmitter.recording = false
    }
    writing_timer.clear()

    if (speechStream.isActive()) {
      Log.info("end_stream")
      speechStream.stream.end()
      speechStream.clear()
    }
  }

  // 認識ストリームの作成 GOOGLE_APPLICATION_CREDENTIALS が未設定の場合はファイル書き出し
  const genStream = (props: { fname: string }) => {
    Log.info("genStream")
    if (voskSpeechClient) {
      Log.info("new vosk speech stream")

      return fs.createWriteStream(props.fname)
    } else {
      Log.info("new file stream")
      return fs.createWriteStream(props.fname)
    }
  }

  // 音声区間検出
  recorder.on("voice_start", () => {
    if (!recorder.recording) return
    Log.info("writing_start")
    if (!speechStream.isActive()) {
      const fname = `./work/output-${timestamp()}.raw`
      if (!voskSpeechClient) {
        Log.info("writing...", fname)
      }
      speechStream.stream = genStream({ fname })
      speechStream.filename = fname
    }
    speechEmitter.writing = true
    writing_timer.clear()
  })

  // 無音区間検出
  recorder.on("voice_stop", () => {
    if (!recorder.recording) return
    Log.info("writing_stop")
    writing_timeout()
  })

  // 音声データ受信
  recorder.on("data", (payload) => {
    if (speechEmitter.writing && speechEmitter.recording) {
      speechEmitter.writing = true
      if (speechStream.isActive()) {
        if (streamQue.length > 0) {
          streamQue.forEach((raw) => {
            speechStream.stream.write(raw)
            //
            if(recognizer.acceptWaveform(raw)) {
              const result = recognizer.result()
              Log.info(`result_q ${JSON.stringify(result, null, "  ")}`)
              emitResult(
                result["text"].replace(/\s+/g,''),
              )
              end_recording()
            } else {
              const result = recognizer.partialResult()
              //Log.info(`result_q ${JSON.stringify(result, null, "  ")}`)
            }
          })
          streamQue = []
        }
        speechStream.stream.write(payload.raw)
        
        if(recognizer.acceptWaveform(payload.raw)) {
          const result = recognizer.result()
          Log.info(`result ${JSON.stringify(result, null, "  ")}`)
          emitResult(
            result["text"].replace(/\s+/g,''),
          )
          end_recording()
        } else {
          const result = recognizer.partialResult()
          //Log.info(`p_result ${JSON.stringify(result, null, "  ")}`)
        }


      }
    } else {
      streamQue.push(payload.raw)
      streamQue = streamQue.slice(-PRELOAD_COUNT)
    }
  })

  // マイクの音声認識の閾値を変更
  speechEmitter.on("mic_threshold", (threshold) => {
    //
  })

  // 音声解析開始
  speechEmitter.on("startRecording", async (params) => {
    Log.info("startRecording", params)
    start_recording()

    Log.info("#", "startRecording", recorder.recording)
  })

  // 音声解析停止
  speechEmitter.on("stopRecording", async () => {
   
    const result = recognizer.finalResult()
    Log.info(`f_result ${JSON.stringify(result, null, "  ")}`)
    const result_text = result["text"].replace(/\s+/g,'')
    if (result_text) {      
      emitResult(
      	result_text,
      )
    }
    //recognizer.reset()

    end_recording()
    Log.info("#", "stopRecording")
  })

  return speechEmitter
}

export default Speech

////////////////////////////////////////////////////////////////////////////////////////////////////////
// main
////////////////////////////////////////////////////////////////////////////////////////////////////////

function micRecorder() {
  const sp = Speech()
  const startRecording = () => {
    setTimeout(() => {
      sp.emit("startRecording", {
        languageCode: ["ja-JP", "en-US"],
      })
    }, 1000)
  }
  sp.on("data", (payload) => {
    Log.info(payload)
     startRecording()
  })
  startRecording()
}

function main() {
  micRecorder()
}

if (require.main === module) {
  main()
}
