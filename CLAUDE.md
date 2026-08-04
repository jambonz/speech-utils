# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

`@jambonz/speech-utils` is a Node.js library providing TTS (Text-to-Speech) utilities for the jambonz CPaaS platform. It handles speech synthesis with caching through Redis and supports multiple TTS vendors.

## Commands

```bash
# Run tests (requires Docker for Redis)
npm test

# Run linter
npm run jslint

# Auto-fix lint issues
npm run jslint:fix

# Generate coverage report
npm run coverage
```

## Testing

Tests use `tape` and require Redis. The test harness automatically starts/stops Redis via Docker Compose (`test/docker-compose-testbed.yaml`).

Most tests are conditional based on environment variables for vendor credentials:
- `GCP_FILE` or `GCP_JSON_KEY` - Google TTS
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION` - AWS Polly
- `MICROSOFT_API_KEY`, `MICROSOFT_REGION` - Azure TTS
- `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID` - ElevenLabs
- `OPENAI_API_KEY` - OpenAI Whisper TTS
- And others per vendor

Redis config is in `config/test.json` (port 3379).

## Architecture

### Entry Point

`index.js` exports a factory function that takes Redis options and a logger, returning an object with these methods:
- `synthAudio` - Main synthesis function
- `getTtsVoices` - List available voices for a vendor
- `purgeTtsCache` / `getTtsSize` / `addFileToCache` - Cache management
- `getAwsAuthToken` - Token management

### Core Module: `lib/synth-audio.js`

The `synthAudio` function handles synthesis for all vendors. Key behaviors:
1. **Cache check**: Generates SHA1 hash key from (vendor, language, voice, engine, model, text, instructions)
2. **Streaming vs non-streaming**: When `JAMBONES_DISABLE_TTS_STREAMING` is not set and `renderForCaching=false`, returns `say:{params}text` format for FreeSWITCH streaming playback instead of generating files
3. **Vendor dispatch**: Switch statement routes to vendor-specific synth functions (`synthGoogle`, `synthPolly`, `synthMicrosoft`, etc.)
4. **Caching**: Stores audio as base64 JSON in Redis with configurable TTL (default 4 hours)

### Supported Vendors

google, aws/polly, microsoft/azure, nvidia (Riva), wellsaid, elevenlabs, cartesia, inworld, rimelabs, whisper (OpenAI), deepgram, resemble, custom:*

### gRPC Stubs

`stubs/riva/` contains generated protobuf/gRPC code for NVIDIA Riva.

## Environment Variables

Key configuration via env vars (see `lib/config.js`):
- `JAMBONES_DISABLE_TTS_STREAMING` - Force non-streaming mode
- `JAMBONES_DISABLE_AZURE_TTS_STREAMING` - Azure-specific streaming disable
- `JAMBONES_TTS_CACHE_DURATION_MINS` - Cache TTL in minutes (default: 240)
- `JAMBONES_TTS_TRIM_SILENCE` - Trim trailing silence from audio
- `JAMBONES_TMP_FOLDER` - Temp folder for audio files (default: /tmp)
- `JAMBONES_HTTP_PROXY_IP`, `JAMBONES_HTTP_PROXY_PORT` - HTTP proxy for Azure
- `JAMBONES_AZURE_ENABLE_SSML` - Force SSML wrapper for Azure plain text

## Key Dependencies

- `@jambonz/realtimedb-helpers` - Redis client and hash utilities
- `@google-cloud/text-to-speech` - Google TTS
- `@aws-sdk/client-polly` - AWS Polly
- `microsoft-cognitiveservices-speech-sdk` - Azure TTS
- `@grpc/grpc-js` - gRPC for Riva
- `openai` - OpenAI Whisper TTS
- `bent` - HTTP client for REST-based vendors
