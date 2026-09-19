"""Offline-only debug transcription. Usage: python script metadata.json transcript.json."""
import json
import os
import subprocess
import sys
from pathlib import Path

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
stage = 20


def main():
    global stage
    metadata_path = Path(sys.argv[1]).resolve()
    output_path = Path(sys.argv[2]).resolve()
    directory = metadata_path.parent
    if output_path.parent != directory:
        raise ValueError('Output outside recording directory')
    metadata = json.loads(metadata_path.read_text())
    model_name = metadata['model']
    model_path = Path(model_name).expanduser().resolve()
    if not model_path.exists():
        raise ValueError('Whisper model must already exist locally')
    os.environ['PATH'] = str(Path(metadata['ffmpeg']).parent) + os.pathsep + os.environ.get('PATH', '')
    requested_engine = metadata.get('engine', 'auto')
    try:
        if requested_engine not in ('auto', 'mlx'):
            raise ImportError()
        import mlx_whisper
        engine = 'mlx'
    except ImportError:
        if requested_engine == 'mlx':
            raise
        try:
            from faster_whisper import WhisperModel
            model = WhisperModel(str(model_path), device='cpu', compute_type='int8', local_files_only=True)
            engine = 'faster_whisper'
        except ImportError:
            import whisper
            if not model_path.is_file():
                raise ValueError('OpenAI Whisper requires a local model file')
            model = whisper.load_model(str(model_path), device='cpu')
            engine = 'whisper'
    segments = []
    for speaker, track in metadata['tracks'].items():
        stage = 21
        if speaker not in ('user', 'assistant'):
            raise ValueError('Unknown speaker')
        source = (directory / track['file']).resolve()
        if source.parent != directory or not source.is_file():
            raise ValueError('Invalid recording file')
        offset = float(track.get('offsetMs', 0)) / 1000
        if not 0 <= offset <= 300:
            raise ValueError('Invalid recording offset')
        wav = directory / (speaker + '.wav')
        command = [metadata['ffmpeg'], '-nostdin', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file,pipe']
        encoding = track['encoding']
        if encoding in ('pcmu', 'pcm16'):
            command += ['-f', 'mulaw' if encoding == 'pcmu' else 's16le', '-ar', str(track['sampleRate']), '-ac', '1']
        command += ['-i', str(source), '-t', str(max(0, 300 - offset)), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(wav)]
        subprocess.run(command, check=True, timeout=60, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.chmod(wav, 0o600)
        stage = 22
        if engine == 'mlx':
            parts = mlx_whisper.transcribe(str(wav), path_or_hf_repo=str(model_path), verbose=False, word_timestamps=False)['segments']
        elif engine == 'faster_whisper':
            result, _ = model.transcribe(str(wav), beam_size=3, vad_filter=True)
            parts = ({'start': part.start, 'end': part.end, 'text': part.text} for part in result)
        else:
            parts = model.transcribe(str(wav), fp16=False)['segments']
        for part in parts:
            start, end = float(part['start']) + offset, float(part['end']) + offset
            segments.append({'speaker': speaker, 'start': min(300, start), 'end': min(300, end), 'text': str(part['text']).strip()})
    segments.sort(key=lambda part: (part['start'], part['speaker']))
    stage = 23
    output_path.write_text(json.dumps({'segments': segments}, ensure_ascii=False))
    os.chmod(output_path, 0o600)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # The API reports a bounded diagnostic; never print audio text or raw provider data.
        sys.exit(stage)
