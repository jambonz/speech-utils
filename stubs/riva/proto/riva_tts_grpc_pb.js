// GENERATED CODE -- DO NOT EDIT!

// Original file comments:
// SPDX-FileCopyrightText: Copyright (c) 2022 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: MIT
//
'use strict';
var grpc = require('@grpc/grpc-js');
var riva_proto_riva_tts_pb = require('../../riva/proto/riva_tts_pb.js');
var riva_proto_riva_audio_pb = require('../../riva/proto/riva_audio_pb.js');

function serialize_nvidia_riva_tts_RivaSynthesisConfigRequest(arg) {
  if (!(arg instanceof riva_proto_riva_tts_pb.RivaSynthesisConfigRequest)) {
    throw new Error('Expected argument of type nvidia.riva.tts.RivaSynthesisConfigRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_nvidia_riva_tts_RivaSynthesisConfigRequest(buffer_arg) {
  return riva_proto_riva_tts_pb.RivaSynthesisConfigRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_nvidia_riva_tts_RivaSynthesisConfigResponse(arg) {
  if (!(arg instanceof riva_proto_riva_tts_pb.RivaSynthesisConfigResponse)) {
    throw new Error('Expected argument of type nvidia.riva.tts.RivaSynthesisConfigResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_nvidia_riva_tts_RivaSynthesisConfigResponse(buffer_arg) {
  return riva_proto_riva_tts_pb.RivaSynthesisConfigResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_nvidia_riva_tts_SynthesizeSpeechRequest(arg) {
  if (!(arg instanceof riva_proto_riva_tts_pb.SynthesizeSpeechRequest)) {
    throw new Error('Expected argument of type nvidia.riva.tts.SynthesizeSpeechRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_nvidia_riva_tts_SynthesizeSpeechRequest(buffer_arg) {
  return riva_proto_riva_tts_pb.SynthesizeSpeechRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_nvidia_riva_tts_SynthesizeSpeechResponse(arg) {
  if (!(arg instanceof riva_proto_riva_tts_pb.SynthesizeSpeechResponse)) {
    throw new Error('Expected argument of type nvidia.riva.tts.SynthesizeSpeechResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_nvidia_riva_tts_SynthesizeSpeechResponse(buffer_arg) {
  return riva_proto_riva_tts_pb.SynthesizeSpeechResponse.deserializeBinary(new Uint8Array(buffer_arg));
}


var RivaSpeechSynthesisService = exports.RivaSpeechSynthesisService = {
  // Used to request text-to-speech from the service. Submit a request containing the
// desired text and configuration, and receive audio bytes in the requested format.
synthesize: {
    path: '/nvidia.riva.tts.RivaSpeechSynthesis/Synthesize',
    requestStream: false,
    responseStream: false,
    requestType: riva_proto_riva_tts_pb.SynthesizeSpeechRequest,
    responseType: riva_proto_riva_tts_pb.SynthesizeSpeechResponse,
    requestSerialize: serialize_nvidia_riva_tts_SynthesizeSpeechRequest,
    requestDeserialize: deserialize_nvidia_riva_tts_SynthesizeSpeechRequest,
    responseSerialize: serialize_nvidia_riva_tts_SynthesizeSpeechResponse,
    responseDeserialize: deserialize_nvidia_riva_tts_SynthesizeSpeechResponse,
  },
  // Used to request text-to-speech returned via stream as it becomes available.
// Submit a SynthesizeSpeechRequest with desired text and configuration,
// and receive stream of bytes in the requested format.
synthesizeOnline: {
    path: '/nvidia.riva.tts.RivaSpeechSynthesis/SynthesizeOnline',
    requestStream: false,
    responseStream: true,
    requestType: riva_proto_riva_tts_pb.SynthesizeSpeechRequest,
    responseType: riva_proto_riva_tts_pb.SynthesizeSpeechResponse,
    requestSerialize: serialize_nvidia_riva_tts_SynthesizeSpeechRequest,
    requestDeserialize: deserialize_nvidia_riva_tts_SynthesizeSpeechRequest,
    responseSerialize: serialize_nvidia_riva_tts_SynthesizeSpeechResponse,
    responseDeserialize: deserialize_nvidia_riva_tts_SynthesizeSpeechResponse,
  },
  // Enables clients to request the configuration of the current Synthesize service, or a specific model within the service.
getRivaSynthesisConfig: {
    path: '/nvidia.riva.tts.RivaSpeechSynthesis/GetRivaSynthesisConfig',
    requestStream: false,
    responseStream: false,
    requestType: riva_proto_riva_tts_pb.RivaSynthesisConfigRequest,
    responseType: riva_proto_riva_tts_pb.RivaSynthesisConfigResponse,
    requestSerialize: serialize_nvidia_riva_tts_RivaSynthesisConfigRequest,
    requestDeserialize: deserialize_nvidia_riva_tts_RivaSynthesisConfigRequest,
    responseSerialize: serialize_nvidia_riva_tts_RivaSynthesisConfigResponse,
    responseDeserialize: deserialize_nvidia_riva_tts_RivaSynthesisConfigResponse,
  },
};

exports.RivaSpeechSynthesisClient = grpc.makeGenericClientConstructor(RivaSpeechSynthesisService);
