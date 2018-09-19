/**
 * @module fly
 * @private
 */
import { libfly } from "./libfly";
import { flatbuffers } from "flatbuffers";
import * as fbs from "./msg_generated";
import * as errors from "./errors";
import * as util from "./util";
import FlyBody from "./body_mixin";
import { FlyRequest } from "./request";
import { Response, ResponseInit } from "./dom_types";
import { FlyResponse } from "./response";
import { ReadableStream, ReadableStreamSource, StreamStrategy } from "@stardazed/streams";

let nextCmdId = 1; // 0 is for events
const promiseTable = new Map<number, util.Resolvable<fbs.Base>>();
const listenerTable = new Map<fbs.Any, Function>();
const bodies = new Map<number, (msg: fbs.StreamChunk) => void>();

// class FlyStream extends ReadableStream {
//   constructor(source?: ReadableStreamSource, strategy?: StreamStrategy) {
//     super(source, strategy)
//   }

// }

export function handleAsyncMsgFromRust(ui8: Uint8Array) {
  const bb = new flatbuffers.ByteBuffer(ui8);
  const base = fbs.Base.getRootAsBase(bb);
  const cmdId = base.cmdId();
  if (cmdId != 0)
    return handleCmdResponse(cmdId, base);

  handleEvent(base);
}

function handleCmdResponse(cmdId: number, base: fbs.Base) {
  const promise = promiseTable.get(cmdId);
  util.assert(promise != null, `Expecting promise in table. ${cmdId}`);
  promiseTable.delete(cmdId);
  const err = errors.maybeError(base);
  if (err != null) {
    promise!.reject(err);
  } else {
    promise!.resolve(base);
  }
}

function handleEvent(base: fbs.Base) {
  const type = base.msgType();
  if (type == fbs.Any.StreamChunk) {
    handleBody(base)
    return
  }
  const ln = listenerTable.get(type);
  if (!ln) {
    console.warn("unhandled event:", fbs.Any[type]);
    return
  }
  ln.call(window, base);
}

function handleBody(base: fbs.Base) {
  let msg = new fbs.StreamChunk();
  base.msg(msg);

  let enqueuer = bodies.get(msg.id())
  if (enqueuer)
    enqueuer(msg)
}

export function addEventListener(name: string, fn: Function) {
  switch (name) {
    case "fetch":
      listenerTable.set(fbs.Any.HttpRequest, function (base: fbs.Base) {
        let msg = new fbs.HttpRequest();
        base.msg(msg);

        const headersInit: string[][] = [];
        // console.log("headers len:", msg.headersLength());
        for (let i = 0; i < msg.headersLength(); i++) {
          const h = msg.headers(i);
          // console.log("header:", h.key(), h.value());
          headersInit.push([h.key(), h.value()]);
        }

        let req = new FlyRequest(msg.url(), {
          method: fbs.HttpMethod[msg.method()].toUpperCase(),
          headers: headersInit,
          body: new ReadableStream({
            start(controller) {
              bodies.set(msg.id(), (chunkMsg: fbs.StreamChunk) => {
                controller.enqueue(chunkMsg.bytesArray());
                if (chunkMsg.done()) {
                  controller.close()
                  bodies.delete(chunkMsg.id())
                }
              })
            }
          })
        })

        fn.call(window, {
          request: req,
          respondWith(resfn: () => Promise<FlyResponse>) {
            resfn().then((res) => {
              // console.log("respond with!", res);

              const fbb = new flatbuffers.Builder();

              let headersArr = Array.from(res.headers[Symbol.iterator]());
              const headersLength = headersArr.length;
              let fbbHeaders = Array<number>();

              try {
                // console.log("trying stuff")
                for (let i = 0; i < headersLength; i++) {
                  // console.log("doing header:", headerKeys[i]);
                  const key = fbb.createString(headersArr[i].name);
                  const value = fbb.createString(headersArr[i].value);
                  fbs.HttpHeader.startHttpHeader(fbb);
                  fbs.HttpHeader.addKey(fbb, key);
                  fbs.HttpHeader.addValue(fbb, value);
                  fbbHeaders[i] = fbs.HttpHeader.endHttpHeader(fbb);
                }
                // console.log(fbbHeaders);
                let resHeaders = fbs.HttpResponse.createHeadersVector(fbb, fbbHeaders);

                fbs.HttpResponse.startHttpResponse(fbb);
                fbs.HttpResponse.addId(fbb, msg.id());
                fbs.HttpResponse.addHeaders(fbb, resHeaders);

                const resMsg = fbs.HttpResponse.endHttpResponse(fbb);
                sendAsync(fbb, fbs.Any.HttpResponse, resMsg);
              } catch (e) {
                console.log("caught an error:", e.message, e.stack);
                throw e
              }
            })
          }
        })
      })
  }
}

// @internal
export function sendAsync(
  fbb: flatbuffers.Builder,
  msgType: fbs.Any,
  msg: flatbuffers.Offset
): Promise<fbs.Base> {
  const [cmdId, resBuf] = sendInternal(fbb, msgType, msg, false);
  util.assert(resBuf == null);
  const promise = util.createResolvable<fbs.Base>();
  promiseTable.set(cmdId, promise);
  return promise;
}

// @internal
export function sendSync(
  fbb: flatbuffers.Builder,
  msgType: fbs.Any,
  msg: flatbuffers.Offset
): null | fbs.Base {
  const [cmdId, resBuf] = sendInternal(fbb, msgType, msg, true);
  util.assert(cmdId >= 0);
  if (resBuf == null) {
    return null;
  } else {
    const u8 = new Uint8Array(resBuf!);
    // console.log("recv sync message", util.hexdump(u8));
    const bb = new flatbuffers.ByteBuffer(u8);
    const baseRes = fbs.Base.getRootAsBase(bb);
    errors.maybeThrowError(baseRes);
    return baseRes;
  }
}

function sendInternal(
  fbb: flatbuffers.Builder,
  msgType: fbs.Any,
  msg: flatbuffers.Offset,
  sync = true
): [number, null | Uint8Array] {
  const cmdId = nextCmdId++;
  fbs.Base.startBase(fbb);
  fbs.Base.addMsg(fbb, msg);
  fbs.Base.addMsgType(fbb, msgType);
  fbs.Base.addSync(fbb, sync);
  fbs.Base.addCmdId(fbb, cmdId);
  fbb.finish(fbs.Base.endBase(fbb));

  return [cmdId, libfly.send(fbb.asUint8Array())];
}