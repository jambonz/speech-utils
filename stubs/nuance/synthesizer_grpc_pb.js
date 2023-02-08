// GENERATED CODE -- DO NOT EDIT!

'use strict';
var grpc = require('@grpc/grpc-js');
var synthesizer_pb = require('./synthesizer_pb.js');

function serialize_nuance_tts_v1_GetVoicesRequest(arg) {
  if (!(arg instanceof synthesizer_pb.GetVoicesRequest)) {
    throw new Error('Expected argument of type nuance.tts.v1.GetVoicesRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_nuance_tts_v1_GetVoicesRequest(buffer_arg) {
  return synthesizer_pb.GetVoicesRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_nuance_tts_v1_GetVoicesResponse(arg) {
  if (!(arg instanceof synthesizer_pb.GetVoicesResponse)) {
    throw new Error('Expected argument of type nuance.tts.v1.GetVoicesResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_nuance_tts_v1_GetVoicesResponse(buffer_arg) {
  return synthesizer_pb.GetVoicesResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_nuance_tts_v1_SynthesisRequest(arg) {
  if (!(arg instanceof synthesizer_pb.SynthesisRequest)) {
    throw new Error('Expected argument of type nuance.tts.v1.SynthesisRequest');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_nuance_tts_v1_SynthesisRequest(buffer_arg) {
  return synthesizer_pb.SynthesisRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_nuance_tts_v1_SynthesisResponse(arg) {
  if (!(arg instanceof synthesizer_pb.SynthesisResponse)) {
    throw new Error('Expected argument of type nuance.tts.v1.SynthesisResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_nuance_tts_v1_SynthesisResponse(buffer_arg) {
  return synthesizer_pb.SynthesisResponse.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_nuance_tts_v1_UnarySynthesisResponse(arg) {
  if (!(arg instanceof synthesizer_pb.UnarySynthesisResponse)) {
    throw new Error('Expected argument of type nuance.tts.v1.UnarySynthesisResponse');
  }
  return Buffer.from(arg.serializeBinary());
}

function deserialize_nuance_tts_v1_UnarySynthesisResponse(buffer_arg) {
  return synthesizer_pb.UnarySynthesisResponse.deserializeBinary(new Uint8Array(buffer_arg));
}


//
// The Synthesizer service offers these functionalities:
// - GetVoices: Queries the list of available voices, with filters to reduce the search space.  
// - Synthesize: Synthesizes audio from input text and parameters, and returns an audio stream. 
// - UnarySynthesize: Synthesizes audio from input text and parameters, and returns a single audio response. 
var SynthesizerService = exports.SynthesizerService = {
  getVoices: {
    path: '/nuance.tts.v1.Synthesizer/GetVoices',
    requestStream: false,
    responseStream: false,
    requestType: synthesizer_pb.GetVoicesRequest,
    responseType: synthesizer_pb.GetVoicesResponse,
    requestSerialize: serialize_nuance_tts_v1_GetVoicesRequest,
    requestDeserialize: deserialize_nuance_tts_v1_GetVoicesRequest,
    responseSerialize: serialize_nuance_tts_v1_GetVoicesResponse,
    responseDeserialize: deserialize_nuance_tts_v1_GetVoicesResponse,
  },
  synthesize: {
    path: '/nuance.tts.v1.Synthesizer/Synthesize',
    requestStream: false,
    responseStream: true,
    requestType: synthesizer_pb.SynthesisRequest,
    responseType: synthesizer_pb.SynthesisResponse,
    requestSerialize: serialize_nuance_tts_v1_SynthesisRequest,
    requestDeserialize: deserialize_nuance_tts_v1_SynthesisRequest,
    responseSerialize: serialize_nuance_tts_v1_SynthesisResponse,
    responseDeserialize: deserialize_nuance_tts_v1_SynthesisResponse,
  },
  unarySynthesize: {
    path: '/nuance.tts.v1.Synthesizer/UnarySynthesize',
    requestStream: false,
    responseStream: false,
    requestType: synthesizer_pb.SynthesisRequest,
    responseType: synthesizer_pb.UnarySynthesisResponse,
    requestSerialize: serialize_nuance_tts_v1_SynthesisRequest,
    requestDeserialize: deserialize_nuance_tts_v1_SynthesisRequest,
    responseSerialize: serialize_nuance_tts_v1_UnarySynthesisResponse,
    responseDeserialize: deserialize_nuance_tts_v1_UnarySynthesisResponse,
  },
};

exports.SynthesizerClient = grpc.makeGenericClientConstructor(SynthesizerService);
