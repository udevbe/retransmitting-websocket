export interface EventLike {
  target: any
  type: 'open' | 'close' | 'error' | 'message'
}

export interface ErrorEventLike extends EventLike {
  error: Error
  message: string
  type: 'error'
}

export interface CloseEventLike extends EventLike {
  type: 'close'
  code: number
  reason: string
  wasClean: boolean
}

export interface MessageEventLike extends EventLike {
  type: 'message'
  readonly data: string | ArrayBuffer
}

export interface RetransmittingWebSocketEventMap {
  close: CloseEventLike
  error: EventLike
  message: MessageEventLike
  open: EventLike
}

export interface WebSocketEventListenerMap {
  close: (event: CloseEventLike) => void
  error: (event: ErrorEventLike) => void
  message: (event: MessageEventLike) => void
  open: (event: EventLike) => void
}

export const enum ReadyState {
  CONNECTING,
  OPEN,
  CLOSING,
  CLOSED,
}

export const enum RETRANSMIT_MSG_TYPE {
  INITIAL_SERIAL = 1,
  DATA,
  DATA_ACK,
  CLOSE,
  CLOSE_ACK,
}

export const defaultMaxBufferSizeBytes = 100000
export const defaultMaxUnacknowledgedMessages = 100
export const defaultMaxTimeMs = 10000
export const defaultCloseTimeoutMs = 1500000
export const defaultReconnectIntervalMs = 3000

export type ListenersMap = {
  error: Array<WebSocketEventListenerMap['error']>
  message: Array<WebSocketEventListenerMap['message']>
  open: Array<WebSocketEventListenerMap['open']>
  close: Array<WebSocketEventListenerMap['close']>
}

export type WebSocketLike = {
  readonly binaryType: string
  readyState: number
  close(code?: number, reason?: string): void
  send(message: ArrayBufferLike | string): void
  removeEventListener<T extends keyof WebSocketEventListenerMap>(
    name: T,
    eventListener: WebSocketEventListenerMap[T],
  ): void
  addEventListener<T extends keyof RetransmittingWebSocketEventMap>(
    name: T,
    eventListener: WebSocketEventListenerMap[T],
  ): void
}

function callEventListener<T extends keyof WebSocketEventListenerMap>(
  event: RetransmittingWebSocketEventMap[T],
  listener: WebSocketEventListenerMap[T],
) {
  if ('handleEvent' in listener) {
    // @ts-ignore
    listener.handleEvent(event)
  } else {
    // @ts-ignore
    listener(event)
  }
}

export class RetransmittingWebSocket implements WebSocketLike {
  /**
   * An event listener to be called when the WebSocket connection's readyState changes to CLOSED
   */
  onclose: ((event: CloseEventLike) => void) | null = null
  /**
   * An event listener to be called when an error occurs
   */
  onerror: ((event: ErrorEventLike) => void) | null = null
  /**
   * An event listener to be called when a message is received from the server
   */
  onmessage: ((event: MessageEventLike) => void) | null = null
  /**
   * An event listener to be called when the WebSocket connection's readyState changes to OPEN;
   * this indicates that the connection is ready to send and receive data
   */
  onopen: ((event: EventLike) => void) | null = null

  private pendingAckMessages: (ArrayBufferLike | string)[] = []
  private receiveSerial = 0
  private processedSerial = 0
  private bufferLowestSerial = 0
  private unacknowledgedSize = 0
  private unacknowledgedMessages = 0
  private unacknowledgedTimoutTask?: ReturnType<typeof setTimeout>
  private closedTimeoutTask?: ReturnType<typeof setTimeout>
  private ws?: WebSocketLike
  private receivedHeader?: { typeId: number; data?: number }
  private pendingCloseEvent?: CloseEventLike
  private pendingErrorEvent?: ErrorEventLike
  private closeAcknowledged?: boolean

  private listeners: ListenersMap = {
    error: [],
    message: [],
    open: [],
    close: [],
  }
  private _readyState: ReadyState = ReadyState.CONNECTING
  private readonly config: {
    maxUnacknowledgedBufferSizeBytes: number
    maxUnacknowledgedMessages: number
    maxUnacknowledgedTimeMs: number
    closeTimeoutMs: number
    reconnectIntervalMs: number
    webSocketFactory?: () => WebSocketLike
  }

  readonly binaryType = 'arraybuffer'

  constructor(config?: Partial<RetransmittingWebSocket['config']>) {
    this.config = {
      maxUnacknowledgedBufferSizeBytes: defaultMaxBufferSizeBytes,
      maxUnacknowledgedMessages: defaultMaxUnacknowledgedMessages,
      maxUnacknowledgedTimeMs: defaultMaxTimeMs,
      closeTimeoutMs: defaultCloseTimeoutMs,
      reconnectIntervalMs: defaultReconnectIntervalMs,
      ...config,
    }
    if (this.config.webSocketFactory) {
      this.useWebSocket(this.config.webSocketFactory())
    }
  }
  /**
   * The current state of the connection; this is one of the Ready state constants
   */
  get readyState(): number {
    return this._readyState
  }

  /**
   * Closes the WebSocket connection or connection attempt, if any. If the connection is already
   * CLOSED, this method does nothing
   */
  close(code = 1000, reason = ''): void {
    if (this.readyState === ReadyState.CLOSED || this.readyState === ReadyState.CLOSING) {
      console.warn('Trying close websocket that was already closed or closing.')
      return
    }
    this.pendingCloseEvent = {
      type: 'close',
      code,
      reason,
      target: this,
      wasClean: true,
    }

    this.closeAcknowledged = false
    const closeHeader = new Uint32Array([RETRANSMIT_MSG_TYPE.CLOSE])
    this.pendingAckMessages.push(closeHeader)
    if (this.ws && this.ws.readyState === ReadyState.OPEN) {
      this.ws.send(closeHeader)
    }
    this.ensureClosedTimeoutTask(this.pendingCloseEvent)
    this._readyState = ReadyState.CLOSING
  }

  /**
   * Enqueue specified data to be transmitted to the server over the WebSocket connection
   */
  send(dataBody: ArrayBufferLike | string): void {
    const dataHeader = new Uint32Array([RETRANSMIT_MSG_TYPE.DATA])
    this.pendingAckMessages.push(dataHeader)
    this.pendingAckMessages.push(dataBody)
    if (this.ws && this.ws.readyState === ReadyState.OPEN) {
      this.ws.send(dataHeader)
      this.ws.send(dataBody)
    }
  }

  /**
   * Register an event handler of a specific event type
   */
  public addEventListener<T extends keyof WebSocketEventListenerMap>(
    type: T,
    listener: WebSocketEventListenerMap[T],
  ): void {
    if (this.listeners[type]) {
      // @ts-ignore
      this.listeners[type].push(listener)
    }
  }

  public dispatchEvent(event: EventLike): boolean {
    const listeners = this.listeners[event.type]
    if (listeners) {
      for (const listener of listeners) {
        // @ts-ignore
        callEventListener(event, listener)
      }
    }
    return true
  }

  /**
   * Removes an event listener
   */
  public removeEventListener<T extends keyof WebSocketEventListenerMap>(
    type: T,
    listener: WebSocketEventListenerMap[T],
  ): void {
    if (this.listeners[type]) {
      // @ts-ignore
      this.listeners[type] = this.listeners[type].filter((l) => l !== listener)
    }
  }

  useWebSocket(webSocket: WebSocketLike): void {
    if (webSocket.binaryType !== 'arraybuffer') {
      throw new Error('only arraybuffer websockets are supported')
    }
    if (this.ws) {
      this.removeInternalWebSocketListeners()
    }
    this.ws = webSocket
    if (
      (this._readyState === ReadyState.CONNECTING || this._readyState === ReadyState.OPEN) &&
      this.ws.readyState === ReadyState.OPEN
    ) {
      this.handleInternalWebSocketOpen({
        type: 'open',
        target: this,
      })
    } else if (this.ws.readyState === ReadyState.CLOSED || this.ws.readyState === ReadyState.CLOSING) {
      throw new Error('WebSocket already closed or closing.')
    }
    this.addInternalWebSocketListeners()
  }

  private handleInternalWebSocketOpen(event: EventLike) {
    if (this.ws === undefined) {
      throw new Error('BUG. Received open but no websocket was present.')
    }

    if (this._readyState !== ReadyState.CLOSING) {
      this.cancelClosedTimeoutTask()
    }

    // send enqueued messages (messages sent before websocket open event)
    if (this.ws && this.ws.readyState === ReadyState.OPEN) {
      this.ws.send(new Uint32Array([RETRANSMIT_MSG_TYPE.INITIAL_SERIAL, this.bufferLowestSerial]))
      for (const msg of this.pendingAckMessages) {
        this.ws.send(msg)
      }
    }

    // only send out open event once after first OPEN
    if (this._readyState === ReadyState.CONNECTING) {
      this.pendingErrorEvent = undefined
      this._readyState = ReadyState.OPEN
      if (this.onopen) {
        this.onopen(event)
      }
      this.listeners.open.forEach((listener) => callEventListener(event, listener))
    }
  }

  private handleInternalWebSocketMessage(event: MessageEventLike) {
    let processData = false
    if (this.receivedHeader === undefined) {
      // copy data to make sure no modifications happen to it (also required for use with uWebsocket library)
      const headerData = event.data as ArrayBuffer
      this.receivedHeader = {
        typeId: new Uint32Array(headerData, 0, 1)[0],
        data:
          headerData.byteLength > Uint32Array.BYTES_PER_ELEMENT
            ? new Uint32Array(headerData, Uint32Array.BYTES_PER_ELEMENT, 1)[0]
            : undefined,
      }
    } else {
      processData = true
    }

    if (this.receivedHeader.typeId === RETRANSMIT_MSG_TYPE.INITIAL_SERIAL) {
      // @ts-ignore
      this.receiveSerial = this.receivedHeader.data
      this.receivedHeader = undefined
      return
    }

    if (this.receivedHeader.typeId === RETRANSMIT_MSG_TYPE.DATA_ACK) {
      // @ts-ignore
      const sendUntil: number = this.receivedHeader.data
      this.pendingAckMessages = this.pendingAckMessages.slice(
        sendUntil - this.bufferLowestSerial,
        this.pendingAckMessages.length,
      )
      this.bufferLowestSerial = sendUntil
      this.receivedHeader = undefined
      return
    }

    if (this.receivedHeader.typeId === RETRANSMIT_MSG_TYPE.CLOSE_ACK) {
      this.receiveSerial++
      this.closeAcknowledged = true
      if (this.pendingCloseEvent) {
        this.closeInternal(this.pendingCloseEvent)
        this.ws?.close(this.pendingCloseEvent.code, this.pendingCloseEvent.reason)
      } else {
        //console.warn('Received a CLOSE_ACK without a pending close event. Server-Client state out of sync?')
        throw new Error('BUG. Received a CLOSE_ACK without a pending close event.')
      }
      this.receivedHeader = undefined
      return
    }

    if (this.receivedHeader.typeId === RETRANSMIT_MSG_TYPE.CLOSE) {
      this.receiveSerial++
      const closeAckMessage = new Uint32Array([RETRANSMIT_MSG_TYPE.CLOSE_ACK])
      this.pendingAckMessages.push(closeAckMessage)
      if (this.ws && this.ws.readyState === ReadyState.OPEN) {
        this.ws.send(closeAckMessage)
      }
      this.closing()
      this.receivedHeader = undefined
      return
    }

    if (this.receivedHeader.typeId === RETRANSMIT_MSG_TYPE.DATA) {
      this.receiveSerial++
      if (processData) {
        if (this.receiveSerial > this.processedSerial) {
          if (this._readyState === ReadyState.OPEN) {
            this.onmessage?.(event)
            this.listeners.message.forEach((listener) => callEventListener(event, listener))
          }

          this.processedSerial = this.receiveSerial
        }
        this.unacknowledgedSize += typeof event.data === 'string' ? event.data.length : event.data.byteLength
        this.unacknowledgedMessages++

        this.ensureUnacknowledgedTimoutTask()

        if (
          this.unacknowledgedSize > this.config.maxUnacknowledgedBufferSizeBytes ||
          this.unacknowledgedMessages > this.config.maxUnacknowledgedMessages
        ) {
          this.sendAck()
        }
        this.receivedHeader = undefined
      }
      return
    }
  }

  private handleInternalWebSocketError(event: ErrorEventLike) {
    this.pendingErrorEvent = event
  }

  private closing() {
    this._readyState = ReadyState.CLOSING
    this.cancelClosedTimeoutTask()
  }

  private closeInternal(event: CloseEventLike) {
    if (this.readyState === ReadyState.CLOSED) {
      return
    }
    if (this.readyState !== ReadyState.CLOSING) {
      throw new Error('BUG. Ready state must be CLOSING before transitioning to CLOSED')
    }
    this.cancelClosedTimeoutTask()
    this._readyState = ReadyState.CLOSED
    if (this.pendingErrorEvent) {
      const pendingErrorEvent = this.pendingErrorEvent
      if (this.onerror) {
        this.onerror(pendingErrorEvent)
      }
      this.listeners.error.forEach((listener) => callEventListener(pendingErrorEvent, listener))
    }

    if (this.onclose) {
      this.onclose(event)
    }
    this.listeners.close.forEach((listener) => callEventListener(event, listener))
    this.removeInternalWebSocketListeners()
  }

  private ensureClosedTimeoutTask(event: CloseEventLike) {
    if (this._readyState === ReadyState.CLOSING || this._readyState === ReadyState.CLOSED || this.closedTimeoutTask) {
      return
    }
    this.closedTimeoutTask = setTimeout(() => {
      this.closedTimeoutTask = undefined
      this._readyState = ReadyState.CLOSING
      this.closeInternal(event)
    }, this.config.closeTimeoutMs)
  }

  private cancelClosedTimeoutTask() {
    if (this.closedTimeoutTask) {
      clearTimeout(this.closedTimeoutTask)
      this.closedTimeoutTask = undefined
    }
  }

  private handleInternalWebSocketClose(event: CloseEventLike) {
    if (
      this.readyState === ReadyState.CONNECTING ||
      this.readyState === ReadyState.OPEN ||
      this.closeAcknowledged === false
    ) {
      if (this.config.webSocketFactory) {
        const webSocketFactory = this.config.webSocketFactory
        setTimeout(() => this.useWebSocket(webSocketFactory()), this.config.reconnectIntervalMs)
      }
      this.ensureClosedTimeoutTask(event)
    } else if (this.readyState === ReadyState.CLOSING) {
      this.closeInternal(event)
    }
  }

  private removeInternalWebSocketListeners() {
    if (!this.ws) {
      return
    }
    this.ws.removeEventListener('open', this.handleInternalWebSocketOpen.bind(this))
    this.ws.removeEventListener('close', this.handleInternalWebSocketClose.bind(this))
    this.ws.removeEventListener('message', this.handleInternalWebSocketMessage.bind(this))
    // @ts-ignore
    this.ws.removeEventListener('error', this.handleInternalWebSocketError.bind(this))
  }

  private addInternalWebSocketListeners() {
    if (!this.ws) {
      return
    }
    this.ws.addEventListener('open', this.handleInternalWebSocketOpen.bind(this))
    this.ws.addEventListener('close', this.handleInternalWebSocketClose.bind(this))
    this.ws.addEventListener('message', this.handleInternalWebSocketMessage.bind(this))
    // @ts-ignore
    this.ws.addEventListener('error', this.handleInternalWebSocketError.bind(this))
  }

  private sendAck() {
    if (this.ws && this.ws.readyState === ReadyState.OPEN) {
      this.ws.send(new Uint32Array([RETRANSMIT_MSG_TYPE.DATA_ACK, this.processedSerial]))
      this.unacknowledgedSize = 0
      this.unacknowledgedMessages = 0
      this.cancelUnacknowledgedTimoutTask()
    }
  }

  private ensureUnacknowledgedTimoutTask() {
    if (this.unacknowledgedTimoutTask === undefined) {
      this.unacknowledgedTimoutTask = setTimeout(() => {
        this.unacknowledgedTimoutTask = undefined
        this.sendAck()
      }, this.config.maxUnacknowledgedTimeMs)
    }
  }

  private cancelUnacknowledgedTimoutTask() {
    if (this.unacknowledgedTimoutTask) {
      clearTimeout(this.unacknowledgedTimoutTask)
      this.unacknowledgedTimoutTask = undefined
    }
  }
}
