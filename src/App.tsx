import { useEffect, useMemo, useRef, useState } from 'react'

type LinkState = 'DISCONNECTED' | 'SCANNING' | 'FOUND' | 'CONNECTING' | 'CONNECTED'
type RunState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETED' | 'ABORTED'
type PhaseKey = 'INHALE' | 'HOLD_IN' | 'EXHALE' | 'HOLD_OUT'
type BreathDirection = 'INHALE' | 'EXHALE'

type BreathAction = {
  id: string
  direction: BreathDirection
  duration: number
  holdDuration: number
  threshold: number
}

type BluetoothCharacteristicHandle = {
  value?: DataView
  startNotifications: () => Promise<BluetoothCharacteristicHandle>
  stopNotifications?: () => Promise<BluetoothCharacteristicHandle>
  writeValueWithoutResponse: (value: Uint8Array) => Promise<void>
  addEventListener: (type: 'characteristicvaluechanged', listener: EventListener) => void
  removeEventListener: (type: 'characteristicvaluechanged', listener: EventListener) => void
}

type BluetoothServiceHandle = {
  getCharacteristic: (uuid: string) => Promise<BluetoothCharacteristicHandle>
}

type BluetoothGattServer = {
  connected: boolean
  connect: () => Promise<BluetoothGattServer>
  disconnect: () => void
  getPrimaryService: (uuid: string) => Promise<BluetoothServiceHandle>
}

type BluetoothDeviceHandle = {
  id: string
  name?: string
  gatt?: BluetoothGattServer
  addEventListener: (type: 'gattserverdisconnected', listener: EventListener) => void
  removeEventListener: (type: 'gattserverdisconnected', listener: EventListener) => void
}

type BluetoothNavigator = Navigator & {
  bluetooth?: {
    requestDevice: (options: {
      acceptAllDevices: boolean
      optionalServices?: string[]
    }) => Promise<BluetoothDeviceHandle>
  }
}

const SPINE_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb'
const SPINE_WRITE_UUID = '0000fff1-0000-1000-8000-00805f9b34fb'
const SPINE_NOTIFY_UUID = '0000fff2-0000-1000-8000-00805f9b34fb'

type LogItem = {
  id: number
  time: string
  level: 'INFO' | 'TX' | 'RX' | 'WARN' | 'PASS'
  event: string
  payload: string
}

type Sample = {
  flow: number
  pressure: number
}

type Sdp800SensorData = {
  pressureRaw: number
  temperatureRaw: number
  pressureDivisor: number
  pressurePa: number
  temperatureC: number
}

type DecodedSensorPacket = {
  declaredLength: number
  actualLength: number
  command: number
  checksum: number
  payload: number[]
  sensorData: Sdp800SensorData | null
}

type TestCase = {
  id: string
  code: string
  name: string
  description: string
  actions: BreathAction[]
}

const initialActions: BreathAction[] = [
  { id: 'ACTION-001', direction: 'INHALE', duration: 4, holdDuration: 2, threshold: 35 },
  { id: 'ACTION-002', direction: 'EXHALE', duration: 6, holdDuration: 2, threshold: 45 },
]

const cloneActions = (actions: BreathAction[]) => actions.map((action) => ({ ...action }))

const initialTestCase: TestCase = {
  id: 'CASE-001',
  code: 'RHYTHM_4262',
  name: '节律呼吸',
  description: '验证阶段切换、连续达标计时、暂停恢复及结果上报。',
  actions: cloneActions(initialActions),
}

const phaseList: Array<{ key: PhaseKey; label: string; short: string; color: string }> = [
  { key: 'INHALE', label: '吸气', short: '吸', color: '#3eb69f' },
  { key: 'HOLD_IN', label: '吸气后屏息', short: '屏', color: '#8fae73' },
  { key: 'EXHALE', label: '呼气', short: '呼', color: '#ef8f6c' },
  { key: 'HOLD_OUT', label: '呼气后停顿', short: '停', color: '#a8a39b' },
]

const stateLabels: Record<LinkState | RunState, string> = {
  DISCONNECTED: '未连接',
  SCANNING: '扫描中',
  FOUND: '已发现设备',
  CONNECTING: '连接中',
  CONNECTED: '已连接',
  IDLE: '空闲',
  RUNNING: '运行中',
  PAUSED: '已暂停',
  COMPLETED: '已完成',
  ABORTED: '已中止',
}

const levelLabels: Record<LogItem['level'], string> = {
  INFO: '信息',
  TX: '发送',
  RX: '接收',
  WARN: '警告',
  PASS: '通过',
}

const now = () => {
  const date = new Date()
  return `${date.toLocaleTimeString('zh-CN', { hour12: false })}.${String(date.getMilliseconds()).padStart(3, '0')}`
}

const formatTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60)
  const rest = Math.floor(seconds % 60)
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

const dataViewToHex = (value: DataView) =>
  Array.from({ length: value.byteLength }, (_, index) =>
    value.getUint8(index).toString(16).padStart(2, '0').toUpperCase()).join(' ')

const toSigned16 = (value: number) => value < 0x8000 ? value : value - 0x10000

const decodeSdp800 = (data: number[]): Sdp800SensorData | null => {
  if (data.length !== 6) return null
  const pressureRaw = toSigned16((data[0] << 8) | data[1])
  const temperatureRaw = toSigned16((data[2] << 8) | data[3])
  const pressureDivisor = (data[4] << 8) | data[5]
  if (pressureDivisor === 0) return null

  return {
    pressureRaw,
    temperatureRaw,
    pressureDivisor,
    pressurePa: pressureRaw / pressureDivisor,
    temperatureC: temperatureRaw / 200,
  }
}

const splitProtocolPackets = (bytes: number[]) => {
  const packets: number[][] = []
  let buffer = [...bytes]

  while (buffer.length > 0) {
    const headerIndex = buffer.indexOf(0xfb)
    if (headerIndex < 0) return { packets, remaining: [] as number[] }
    if (headerIndex > 0) buffer = buffer.slice(headerIndex)
    if (buffer.length < 2) break

    const declaredLength = buffer[1]
    const totalLength = declaredLength + 2
    if (declaredLength < 2) {
      buffer = buffer.slice(1)
      continue
    }
    if (buffer.length < totalLength) break

    packets.push(buffer.slice(0, totalLength))
    buffer = buffer.slice(totalLength)
  }

  return { packets, remaining: buffer }
}

const decodeSensorPacket = (packet: number[]): DecodedSensorPacket | null => {
  if (packet.length < 4 || packet[0] !== 0xfb || packet.length !== packet[1] + 2) return null

  const command = packet[2]
  const payload = packet.slice(3, -1)
  return {
    declaredLength: packet[1],
    actualLength: packet.length,
    command,
    checksum: packet[packet.length - 1],
    payload,
    sensorData: command === 0x09 && packet[1] === 0x08
      ? decodeSdp800(payload)
      : null,
  }
}

const Icon = ({ name, size = 16 }: { name: string; size?: number }) => {
  const paths: Record<string, JSX.Element> = {
    link: <><path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1" /><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1" /></>,
    play: <path d="m8 5 11 7-11 7Z" fill="currentColor" />,
    pause: <><path d="M9 5v14" /><path d="M15 5v14" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" />,
    refresh: <><path d="M20 7v5h-5" /><path d="M4 17v-5h5" /><path d="M6.1 9A7 7 0 0 1 18 6l2 3M4 15l2 3a7 7 0 0 0 11.9-3" /></>,
    bluetooth: <path d="m7 7 10 10-5 4V3l5 4L7 17" />,
    terminal: <><path d="m5 7 4 4-4 4" /><path d="M11 17h8" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    chevron: <path d="m9 18 6-6-6-6" />,
    alert: <><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10 3 2 20h20L14 3a2.2 2.2 0 0 0-4 0Z" /></>,
    download: <><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></>,
    trash: <><path d="M4 7h16" /><path d="m9 11 1 7m5-7-1 7" /><path d="M6 7l1 14h10l1-14M9 7V4h6v3" /></>,
    activity: <path d="M3 12h4l2-7 5 14 2-7h5" />,
  }

  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  )
}

const StateTag = ({ value }: { value: LinkState | RunState }) => {
  const tone =
    value === 'CONNECTED' || value === 'COMPLETED'
      ? 'ok'
      : value === 'RUNNING'
        ? 'active'
        : value === 'ABORTED'
          ? 'error'
          : value === 'SCANNING' || value === 'CONNECTING'
            ? 'busy'
            : 'neutral'
  return <span className={`state-tag ${tone}`}><i />{stateLabels[value]}</span>
}

function App() {
  const [linkState, setLinkState] = useState<LinkState>('DISCONNECTED')
  const [deviceName, setDeviceName] = useState<string | null>(null)
  const [deviceId, setDeviceId] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [commandHex, setCommandHex] = useState('')
  const [lastRawFrame, setLastRawFrame] = useState<string | null>(null)
  const [rawFrameCount, setRawFrameCount] = useState(0)
  const [protocolPacketCount, setProtocolPacketCount] = useState(0)
  const [lastSplitCount, setLastSplitCount] = useState(0)
  const [decodedSensorData, setDecodedSensorData] = useState<Sdp800SensorData | null>(null)
  const [decodedSensorPacket, setDecodedSensorPacket] = useState<DecodedSensorPacket | null>(null)
  const [runState, setRunState] = useState<RunState>('IDLE')
  const [scenarioLoaded, setScenarioLoaded] = useState(false)
  const [testCases, setTestCases] = useState<TestCase[]>([initialTestCase])
  const [selectedCaseId, setSelectedCaseId] = useState(initialTestCase.id)
  const [showNewCase, setShowNewCase] = useState(false)
  const [newCaseName, setNewCaseName] = useState('')
  const [newCaseCode, setNewCaseCode] = useState('')
  const [elapsed, setElapsed] = useState(0)
  const [actions, setActions] = useState<BreathAction[]>(() => cloneActions(initialActions))
  const [breathInput, setBreathInput] = useState(0)
  const [attemptResets, setAttemptResets] = useState(0)
  const [packetLoss, setPacketLoss] = useState(false)
  const [sensorNoise, setSensorNoise] = useState(true)
  const [pressureAlarm, setPressureAlarm] = useState(false)
  const [samples, setSamples] = useState<Sample[]>(() =>
    Array.from({ length: 80 }, () => ({ flow: 0, pressure: 0 })),
  )
  const [logs, setLogs] = useState<LogItem[]>([
    { id: 1, time: now(), level: 'INFO', event: 'DEBUGGER_READY', payload: '{"connection":"web-bluetooth","sensor_input":"simulated"}' },
  ])
  const logId = useRef(2)
  const completionLogged = useRef(false)
  const hadPhaseProgress = useRef(false)
  const observedPhase = useRef('ACTION-001:INHALE')
  const bluetoothDevice = useRef<BluetoothDeviceHandle | null>(null)
  const bluetoothDisconnectListener = useRef<EventListener | null>(null)
  const writeCharacteristic = useRef<BluetoothCharacteristicHandle | null>(null)
  const notifyCharacteristic = useRef<BluetoothCharacteristicHandle | null>(null)
  const notificationListener = useRef<EventListener | null>(null)
  const protocolBuffer = useRef<number[]>([])
  const latestRawBytes = useRef<number[]>([])
  const latestPacket = useRef<DecodedSensorPacket | null>(null)
  const latestSensorData = useRef<Sdp800SensorData | null>(null)
  const notificationCount = useRef(0)
  const packetCount = useRef(0)
  const splitCount = useRef(0)
  const bluetoothUiTimer = useRef<number | null>(null)
  const lastBluetoothUiAt = useRef(0)
  const lastBluetoothLogAt = useRef(0)
  const actionId = useRef(3)
  const selectedCase = testCases.find((item) => item.id === selectedCaseId) ?? testCases[0]
  const orderedPhases = useMemo(
    () => actions.flatMap((action, actionIndex) => {
      const breathPhase = action.direction === 'INHALE' ? phaseList[0] : phaseList[2]
      const holdPhase = action.direction === 'INHALE' ? phaseList[1] : phaseList[3]
      return [
        { ...breathPhase, duration: action.duration, threshold: action.threshold, actionIndex, actionId: action.id },
        { ...holdPhase, duration: action.holdDuration, threshold: action.threshold, actionIndex, actionId: action.id },
      ]
    }),
    [actions],
  )

  const addLog = (level: LogItem['level'], event: string, payload: object | string = {}) => {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload)
    setLogs((current) => [
      ...current.slice(-199),
      { id: logId.current++, time: now(), level, event, payload: text },
    ])
  }

  const flushBluetoothUi = () => {
    bluetoothUiTimer.current = null
    lastBluetoothUiAt.current = performance.now()
    setLastRawFrame(latestRawBytes.current.map((byte) =>
      byte.toString(16).padStart(2, '0').toUpperCase()).join(' '))
    setRawFrameCount(notificationCount.current)
    setProtocolPacketCount(packetCount.current)
    setLastSplitCount(splitCount.current)
    setDecodedSensorPacket(latestPacket.current)
    if (latestSensorData.current) setDecodedSensorData(latestSensorData.current)
  }

  const scheduleBluetoothUi = () => {
    if (bluetoothUiTimer.current !== null) return
    const delay = Math.max(0, 50 - (performance.now() - lastBluetoothUiAt.current))
    bluetoothUiTimer.current = window.setTimeout(flushBluetoothUi, delay)
  }

  const clearBluetoothStream = () => {
    if (bluetoothUiTimer.current !== null) window.clearTimeout(bluetoothUiTimer.current)
    bluetoothUiTimer.current = null
    protocolBuffer.current = []
    latestRawBytes.current = []
    latestPacket.current = null
    latestSensorData.current = null
    notificationCount.current = 0
    packetCount.current = 0
    splitCount.current = 0
    lastBluetoothUiAt.current = 0
    lastBluetoothLogAt.current = 0
  }

  const cycleDuration = useMemo(
    () => orderedPhases.reduce((total, phase) => total + phase.duration, 0),
    [orderedPhases],
  )
  const totalDuration = cycleDuration
  const cycleElapsed = elapsed % cycleDuration

  const phase = useMemo(() => {
    let cursor = 0
    for (let sequenceIndex = 0; sequenceIndex < orderedPhases.length; sequenceIndex += 1) {
      const item = orderedPhases[sequenceIndex]
      const duration = item.duration
      if (cycleElapsed < cursor + duration) {
        const localElapsed = cycleElapsed - cursor
        return {
          ...item,
          duration,
          elapsed: localElapsed,
          remaining: Math.max(0, duration - localElapsed),
          progress: localElapsed / duration,
          sequenceIndex,
        }
      }
      cursor += duration
    }
    const firstPhase = orderedPhases[0]
    return { ...firstPhase, elapsed: 0, remaining: firstPhase.duration, progress: 0, sequenceIndex: 0 }
  }, [cycleElapsed, orderedPhases])
  const currentAction = Math.min(actions.length, phase.actionIndex + 1)
  const phaseIdentity = `${phase.actionId}:${phase.key}`

  const hasRealSensorInput = linkState === 'CONNECTED' && decodedSensorData !== null
  const inputFlow = hasRealSensorInput ? decodedSensorData.pressurePa : breathInput
  const displayedInput = Math.max(-100, Math.min(100, inputFlow))
  const noise = sensorNoise && runState === 'RUNNING' ? (Math.random() - 0.5) * 0.9 : 0
  const inputDirection = inputFlow < -2 ? 'INHALE' : inputFlow > 2 ? 'EXHALE' : 'NONE'
  const inputDirectionLabel = inputDirection === 'INHALE' ? '吸气' : inputDirection === 'EXHALE' ? '呼气' : '无气流'
  const activeEffort = Math.abs(inputFlow)
  const flow = inputFlow + (hasRealSensorInput ? 0 : noise)
  const pressure = inputFlow + (pressureAlarm ? 80 : 0)
  const volume = hasRealSensorInput ? 0 : Math.round(350 + (inputDirection === 'INHALE' ? activeEffort * 3.6 : 0))
  const isBreathPhase = phase.key === 'INHALE' || phase.key === 'EXHALE'
  const requiredDirection = phase.key === 'INHALE' ? 'INHALE' : 'EXHALE'
  const requiredThreshold = phase.threshold
  const phaseQualified = !isBreathPhase || (
    inputDirection === requiredDirection && activeEffort > requiredThreshold
  )
  const qualificationText = !isBreathPhase
    ? '自动计时'
    : inputDirection !== requiredDirection
      ? `等待${phase.key === 'INHALE' ? '吸气' : '呼气'}`
      : activeEffort <= requiredThreshold
        ? `流量不足，需大于 ${requiredThreshold} L/min`
        : '输入达标，正在计时'

  useEffect(() => {
    if (runState !== 'RUNNING') return
    const timer = window.setInterval(() => {
      setElapsed((current) => {
        if (phaseQualified) return Math.min(totalDuration, current + 0.1)

        const currentCycleElapsed = current % cycleDuration
        let phaseStart = 0
        for (const item of orderedPhases) {
          const duration = item.duration
          if (currentCycleElapsed < phaseStart + duration) {
            const activePhase = item.key === 'INHALE' || item.key === 'EXHALE'
            return activePhase ? current - currentCycleElapsed + phaseStart : current
          }
          phaseStart += duration
        }
        return current
      })
    }, 100)
    return () => window.clearInterval(timer)
  }, [runState, totalDuration, phaseQualified, cycleDuration, orderedPhases])

  useEffect(() => {
    if (runState !== 'RUNNING') return
    if (observedPhase.current !== phaseIdentity) {
      observedPhase.current = phaseIdentity
      hadPhaseProgress.current = false
    }
    if (!isBreathPhase) return
    if (phaseQualified && phase.elapsed >= 0.1) {
      hadPhaseProgress.current = true
    }
    if (!phaseQualified && hadPhaseProgress.current) {
      hadPhaseProgress.current = false
      setAttemptResets((current) => current + 1)
      addLog('WARN', 'PHASE_TIMER_RESET', {
        phase: phase.key,
        reason: inputDirection !== requiredDirection ? 'direction_interrupted' : 'below_threshold',
        threshold_lpm: requiredThreshold,
        actual_lpm: activeEffort,
      })
    }
  }, [runState, phase.key, phase.elapsed, phaseQualified, phaseIdentity, isBreathPhase, inputDirection, requiredDirection, requiredThreshold, activeEffort])

  useEffect(() => {
    if (elapsed >= totalDuration && runState === 'RUNNING') {
      setRunState('COMPLETED')
      if (!completionLogged.current) {
        completionLogged.current = true
        addLog('RX', 'TRAINING_COMPLETE', { duration_s: totalDuration, score: 94 })
        addLog('PASS', 'ASSERT_ALL_PHASES_COMPLETED', { expected: orderedPhases.length, actual: orderedPhases.length })
      }
    }
  }, [elapsed, totalDuration, runState, orderedPhases.length])

  useEffect(() => {
    if (runState !== 'RUNNING') return
    setSamples((current) => [...current.slice(-79), { flow, pressure }])
  }, [Math.floor(elapsed * 5), runState])

  useEffect(() => {
    if (runState !== 'RUNNING') return
    addLog(packetLoss ? 'WARN' : 'RX', 'SENSOR_FRAME', {
      phase: phase.key,
      input_direction: inputDirection,
      input_flow_lpm: Number(inputFlow.toFixed(4)),
      flow_lpm: Number(flow.toFixed(2)),
      pressure_pa: Number(pressure.toFixed(4)),
      ...(packetLoss ? { dropped: true } : {}),
    })
  }, [Math.floor(elapsed), runState])

  const scan = async () => {
    const bluetooth = (navigator as BluetoothNavigator).bluetooth
    setLinkError(null)

    if (!bluetooth) {
      const message = '当前浏览器不支持 Web Bluetooth，请使用 Chrome 或 Edge，并通过 localhost/HTTPS 打开。'
      setLinkError(message)
      addLog('WARN', 'WEB_BLUETOOTH_UNAVAILABLE', { secure_context: window.isSecureContext })
      return
    }

    setLinkState('SCANNING')
    addLog('TX', 'BLE_DEVICE_REQUEST', { accept_all_devices: true })

    try {
      const device = await bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: [SPINE_SERVICE_UUID],
      })
      bluetoothDevice.current = device
      setDeviceName(device.name || '未命名 BLE 设备')
      setDeviceId(device.id)
      setLinkState('FOUND')
      const disconnectListener: EventListener = () => {
        writeCharacteristic.current = null
        notifyCharacteristic.current = null
        notificationListener.current = null
        clearBluetoothStream()
        setLinkState('DISCONNECTED')
        setRunState('IDLE')
        setScenarioLoaded(false)
        setElapsed(0)
        addLog('WARN', 'DEVICE_DISCONNECTED', { reason: 'gatt_link_lost' })
      }
      bluetoothDisconnectListener.current = disconnectListener
      device.addEventListener('gattserverdisconnected', disconnectListener)
      addLog('RX', 'DEVICE_SELECTED', { id: device.id, name: device.name || null })
    } catch (error) {
      const bluetoothError = error as DOMException
      setLinkState('DISCONNECTED')
      if (bluetoothError.name === 'NotFoundError') {
        addLog('INFO', 'DEVICE_SELECTION_CANCELLED')
        return
      }
      const message = bluetoothError.message || '无法打开蓝牙设备选择器。'
      setLinkError(message)
      addLog('WARN', 'BLE_DEVICE_REQUEST_FAILED', { name: bluetoothError.name, message })
    }
  }

  const connect = async () => {
    const device = bluetoothDevice.current
    if (!device?.gatt) {
      setLinkError('所选设备不支持 GATT 连接，请重新选择设备。')
      return
    }

    setLinkState('CONNECTING')
    setLinkError(null)
    addLog('TX', 'GATT_CONNECT', { device_id: device.id })
    try {
      const server = await device.gatt.connect()
      const service = await server.getPrimaryService(SPINE_SERVICE_UUID)
      const writeHandle = await service.getCharacteristic(SPINE_WRITE_UUID)
      const notifyHandle = await service.getCharacteristic(SPINE_NOTIFY_UUID)
      const listener: EventListener = (event) => {
        const characteristic = event.target as unknown as BluetoothCharacteristicHandle
        if (!characteristic.value) return
        const incoming = Array.from(
          { length: characteristic.value.byteLength },
          (_, index) => characteristic.value!.getUint8(index),
        )
        latestRawBytes.current = incoming
        notificationCount.current += 1
        const split = splitProtocolPackets([...protocolBuffer.current, ...incoming])
        protocolBuffer.current = split.remaining
        splitCount.current = split.packets.length
        packetCount.current += split.packets.length

        split.packets.forEach((rawPacket) => {
          const packet = decodeSensorPacket(rawPacket)
          if (!packet) return
          latestPacket.current = packet
          if (packet.sensorData) latestSensorData.current = packet.sensorData
        })

        scheduleBluetoothUi()
        const logTime = performance.now()
        if (logTime - lastBluetoothLogAt.current >= 250) {
          lastBluetoothLogAt.current = logTime
          addLog(latestSensorData.current ? 'PASS' : 'RX', 'BLE_DATA_BATCH', {
            notifications: notificationCount.current,
            packets: packetCount.current,
            latest_command: latestPacket.current
              ? `0x${latestPacket.current.command.toString(16).padStart(2, '0').toUpperCase()}`
              : null,
            pressure_pa: latestSensorData.current
              ? Number(latestSensorData.current.pressurePa.toFixed(4))
              : null,
            buffered_bytes: protocolBuffer.current.length,
          })
        }
      }
      writeCharacteristic.current = writeHandle
      notifyCharacteristic.current = notifyHandle
      notificationListener.current = listener
      notifyHandle.addEventListener('characteristicvaluechanged', listener)
      await notifyHandle.startNotifications()
      setLinkState('CONNECTED')
      addLog('PASS', 'DEVICE_CONNECTED', {
        id: device.id,
        name: device.name || null,
        service: 'FFF0',
        write: 'FFF1',
        notify: 'FFF2',
      })
    } catch (error) {
      const bluetoothError = error as DOMException
      const message = bluetoothError.message || 'GATT 连接失败。'
      writeCharacteristic.current = null
      notifyCharacteristic.current = null
      notificationListener.current = null
      setLinkState('FOUND')
      setLinkError(message)
      addLog('WARN', 'GATT_CONNECT_FAILED', { name: bluetoothError.name, message })
    }
  }

  const sendRawCommand = async () => {
    const characteristic = writeCharacteristic.current
    const compact = commandHex.replace(/0x/gi, '').replace(/[\s,;:-]/g, '')
    if (!characteristic) {
      setLinkError('FFF1 写入特征尚未就绪。')
      return
    }
    if (!compact || compact.length % 2 !== 0 || /[^0-9a-f]/i.test(compact)) {
      setLinkError('请输入完整的十六进制字节，例如：AA 01 00 FF。')
      return
    }

    const bytes = new Uint8Array(compact.match(/.{2}/g)!.map((item) => Number.parseInt(item, 16)))
    try {
      await characteristic.writeValueWithoutResponse(bytes)
      setLinkError(null)
      addLog('TX', 'FFF1_WRITE', { hex: dataViewToHex(new DataView(bytes.buffer)), bytes: bytes.byteLength })
    } catch (error) {
      const bluetoothError = error as DOMException
      const message = bluetoothError.message || 'FFF1 写入失败。'
      setLinkError(message)
      addLog('WARN', 'FFF1_WRITE_FAILED', { name: bluetoothError.name, message })
    }
  }

  const disconnect = () => {
    const device = bluetoothDevice.current
    const notifyHandle = notifyCharacteristic.current
    if (notifyHandle && notificationListener.current) {
      notifyHandle.removeEventListener('characteristicvaluechanged', notificationListener.current)
      if (notifyHandle.stopNotifications) void notifyHandle.stopNotifications().catch(() => undefined)
    }
    if (device) {
      if (bluetoothDisconnectListener.current) {
        device.removeEventListener('gattserverdisconnected', bluetoothDisconnectListener.current)
      }
      if (device.gatt?.connected) device.gatt.disconnect()
    }
    bluetoothDevice.current = null
    bluetoothDisconnectListener.current = null
    writeCharacteristic.current = null
    notifyCharacteristic.current = null
    notificationListener.current = null
    clearBluetoothStream()
    setLinkState('DISCONNECTED')
    setDeviceName(null)
    setDeviceId(null)
    setLinkError(null)
    setLastRawFrame(null)
    setRawFrameCount(0)
    setProtocolPacketCount(0)
    setLastSplitCount(0)
    setDecodedSensorData(null)
    setDecodedSensorPacket(null)
    setRunState('IDLE')
    setScenarioLoaded(false)
    setElapsed(0)
    addLog('WARN', 'DEVICE_DISCONNECTED', { reason: 'manual_debug_action' })
  }

  const selectTestCase = (id: string) => {
    const nextCase = testCases.find((item) => item.id === id)
    if (!nextCase) return
    setSelectedCaseId(id)
    setActions(cloneActions(nextCase.actions))
    setScenarioLoaded(false)
    setRunState('IDLE')
    setElapsed(0)
    setAttemptResets(0)
    addLog('INFO', 'TEST_CASE_SELECTED', { id: nextCase.id, code: nextCase.code })
  }

  const openNewCaseDialog = () => {
    setNewCaseName('')
    setNewCaseCode(`CUSTOM_${String(testCases.length + 1).padStart(3, '0')}`)
    setShowNewCase(true)
  }

  const createTestCase = () => {
    const name = newCaseName.trim()
    const code = newCaseCode.trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '_')
    if (!name || !code || testCases.some((item) => item.code === code)) return
    const nextCase: TestCase = {
      id: `CASE-${String(testCases.length + 1).padStart(3, '0')}`,
      code,
      name,
      description: '自定义训练流程测试用例。',
      actions: cloneActions(actions),
    }
    setTestCases((current) => [...current, nextCase])
    setSelectedCaseId(nextCase.id)
    setScenarioLoaded(false)
    setRunState('IDLE')
    setElapsed(0)
    setAttemptResets(0)
    setShowNewCase(false)
    addLog('INFO', 'TEST_CASE_CREATED', { id: nextCase.id, code: nextCase.code, cloned_from: selectedCase.code })
  }

  const updateActions = (next: BreathAction[]) => {
    if (next.length < 1 || next.length > 8) return
    setActions(next)
    setScenarioLoaded(false)
    setElapsed(0)
    setAttemptResets(0)
  }

  const toggleSequenceStep = (index: number) => {
    updateActions(actions.map((action, itemIndex) => itemIndex === index
      ? { ...action, direction: action.direction === 'INHALE' ? 'EXHALE' : 'INHALE' }
      : action))
  }

  const removeSequenceStep = (index: number) => {
    updateActions(actions.filter((_, itemIndex) => itemIndex !== index))
  }

  const addAction = (direction: BreathDirection) => {
    actionId.current += 1
    updateActions([
      ...actions,
      {
        id: `ACTION-${String(actionId.current).padStart(3, '0')}`,
        direction,
        duration: direction === 'INHALE' ? 4 : 6,
        holdDuration: 2,
        threshold: direction === 'INHALE' ? 35 : 45,
      },
    ])
  }

  const updateActionValue = (index: number, field: 'duration' | 'holdDuration' | 'threshold', value: number) => {
    const minimum = field === 'duration' ? 0.5 : 0
    const maximum = field === 'threshold' ? 1000 : 60
    const normalized = Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum))
    updateActions(actions.map((action, itemIndex) =>
      itemIndex === index ? { ...action, [field]: normalized } : action))
  }

  const loadScenario = () => {
    if (linkState !== 'CONNECTED') return
    setTestCases((current) => current.map((item) => item.id === selectedCase.id
      ? {
        ...item,
        actions: cloneActions(actions),
      }
      : item))
    setScenarioLoaded(true)
    setRunState('IDLE')
    setElapsed(0)
    setAttemptResets(0)
    hadPhaseProgress.current = false
    observedPhase.current = `${orderedPhases[0].actionId}:${orderedPhases[0].key}`
    completionLogged.current = false
    addLog('TX', 'SCENARIO_LOAD', {
      id: selectedCase.code,
      actions: actions.map((action) => ({
        direction: action.direction,
        duration_s: action.duration,
        hold_duration_s: action.holdDuration,
        threshold_lpm: action.threshold,
      })),
    })
    addLog('PASS', 'CONFIG_ACCEPTED', { checksum: '8F2A' })
  }

  const start = () => {
    if (!scenarioLoaded || linkState !== 'CONNECTED') return
    if (runState === 'COMPLETED' || runState === 'ABORTED') {
      setElapsed(0)
      completionLogged.current = false
    }
    setRunState('RUNNING')
    addLog('TX', runState === 'PAUSED' ? 'TRAINING_RESUME' : 'TRAINING_START', {
      scenario: selectedCase.code,
      actions: actions.length,
    })
  }

  const pause = () => {
    setRunState('PAUSED')
    addLog('TX', 'TRAINING_PAUSE', { elapsed_ms: Math.round(elapsed * 1000), phase: phase.key })
  }

  const abort = () => {
    if (runState === 'IDLE') return
    setRunState('ABORTED')
    addLog('WARN', 'TRAINING_ABORT', { elapsed_ms: Math.round(elapsed * 1000), source: 'operator' })
  }

  const injectPressureSpike = () => {
    setPressureAlarm(true)
    addLog('WARN', 'FAULT_INJECTED', { type: 'PRESSURE_SPIKE', added_pa: 80 })
    window.setTimeout(() => {
      setPressureAlarm(false)
      addLog('PASS', 'PRESSURE_RECOVERED', { value_pa: Number(pressure.toFixed(1)) })
    }, 1800)
  }

  const resetAll = () => {
    setRunState('IDLE')
    setScenarioLoaded(false)
    setElapsed(0)
    setPacketLoss(false)
    setPressureAlarm(false)
    setAttemptResets(0)
    setBreathInput(0)
    setSamples(Array.from({ length: 80 }, () => ({ flow: 0, pressure: 0 })))
    completionLogged.current = false
    addLog('INFO', 'TEST_STATE_RESET')
  }

  const chartPath = (field: keyof Sample, max: number) =>
    samples.map((sample, index) => {
      const x = (index / (samples.length - 1)) * 800
      const middle = field === 'flow' ? 80 : 85
      const y = field === 'flow'
        ? middle - (sample[field] / max) * 58
        : middle - (sample[field] / max) * 50
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
    }).join(' ')

  const flowStep =
    linkState !== 'CONNECTED'
      ? 0
      : !scenarioLoaded
        ? 1
        : runState === 'IDLE'
          ? 2
          : runState === 'COMPLETED'
            ? 4
            : 3

  const normalizedNewCaseCode = newCaseCode.trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, '_')
  const newCaseCodeExists = testCases.some((item) => item.code === normalizedNewCaseCode)

  const stateSnapshot = {
    连接状态: stateLabels[linkState],
    蓝牙设备: deviceName ? { 名称: deviceName, ID: deviceId } : null,
    蓝牙原始数据: {
      服务: 'FFF0',
      写入特征: 'FFF1',
      通知特征: 'FFF2',
      已接收通知数: rawFrameCount,
      已拆协议包数: protocolPacketCount,
      最近通知拆包数: lastSplitCount,
      等待拼接字节数: protocolBuffer.current.length,
      最后一帧: lastRawFrame,
      最近协议包: decodedSensorPacket ? {
        声明长度: decodedSensorPacket.declaredLength,
        实际长度: decodedSensorPacket.actualLength,
        命令: `0x${decodedSensorPacket.command.toString(16).padStart(2, '0').toUpperCase()}`,
        数据字节数: decodedSensorPacket.payload.length,
        checksum: `0x${decodedSensorPacket.checksum.toString(16).padStart(2, '0').toUpperCase()}`,
      } : null,
    },
    真实传感器数据: decodedSensorData ? {
      压力原始值: decodedSensorData.pressureRaw,
      温度原始值: decodedSensorData.temperatureRaw,
      压力除数: decodedSensorData.pressureDivisor,
      '压力_Pa': Number(decodedSensorData.pressurePa.toFixed(4)),
      '温度_摄氏度': Number(decodedSensorData.temperatureC.toFixed(2)),
    } : null,
    测试用例: scenarioLoaded ? selectedCase.code : null,
    运行状态: stateLabels[runState],
    当前阶段: runState === 'IDLE' ? null : phase.label,
    阶段顺序: orderedPhases.map((item) => item.label).join(' → '),
    动作配置: actions.map((action) => ({
      类型: action.direction === 'INHALE' ? '吸气' : '呼气',
      '持续时间_秒': action.duration,
      '动作后等待_秒': action.holdDuration,
      '流量阈值_L每分钟': action.threshold,
    })),
    当前动作: `${currentAction}/${actions.length}`,
    已运行毫秒: Math.round(elapsed * 1000),
    传感器: {
      '流量_L每分钟': Number(flow.toFixed(2)),
      '压力_Pa': Number(pressure.toFixed(4)),
      '潮气量_mL': volume,
    },
    传感器输入: {
      来源: hasRealSensorInput ? 'SDP800 压力 1:1 映射' : '手动模拟',
      当前方向: inputDirectionLabel,
      '带方向流量_L每分钟': Number(inputFlow.toFixed(4)),
      '绝对流量_L每分钟': Number(activeEffort.toFixed(4)),
    },
    阶段判定: {
      '要求方向': isBreathPhase ? (requiredDirection === 'INHALE' ? '吸气' : '呼气') : '无',
      '要求流量_L每分钟': isBreathPhase ? requiredThreshold : null,
      是否达标: phaseQualified,
      本次重置次数: attemptResets,
    },
  }

  return (
    <div className="debug-shell">
      <header className="debug-header">
        <div className="tool-title">
          <div className="tool-mark"><Icon name="terminal" size={20} /></div>
          <div>
            <h1>呼吸训练器流程调试工具</h1>
            <p>训练流程与设备数据测试台 <span>开发版 v0.3.0</span></p>
          </div>
        </div>
        <div className="header-status">
          <span className="mode-badge">真实蓝牙 · 压力映射流量</span>
          <span className="session-id">会话 / {String(logId.current).padStart(4, '0')}</span>
          <StateTag value={linkState} />
          <button onClick={resetAll}><Icon name="refresh" />重置状态</button>
        </div>
      </header>

      <div className="flow-strip">
        {['连接设备', '选择用例', '配置参数', '运行测试', '检查结果'].map((item, index) => (
          <div className={`flow-node ${index === flowStep ? 'current' : ''} ${index < flowStep ? 'passed' : ''}`} key={item}>
            <span>{index < flowStep ? <Icon name="check" size={12} /> : String(index + 1).padStart(2, '0')}</span>
            <b>{item}</b>
            {index < 4 && <i />}
          </div>
        ))}
      </div>

      <main className="debug-grid">
        <aside className="control-rail">
          <section className="debug-panel">
            <div className="panel-label"><span>01</span> 设备连接</div>
            <div className="device-row">
              <div className={`device-dot ${linkState === 'CONNECTED' ? 'online' : ''}`}><Icon name="bluetooth" /></div>
              <div><b>{deviceName || '尚未选择设备'}</b><small>{deviceId ? `ID ${deviceId}` : '附近的真实 BLE 外设'}</small></div>
              <StateTag value={linkState} />
            </div>
            {linkState === 'DISCONNECTED' && <button className="control-button primary" onClick={scan}><Icon name="bluetooth" />选择附近设备</button>}
            {linkState === 'SCANNING' && <button className="control-button" disabled><span className="spinner" />等待选择设备…</button>}
            {linkState === 'FOUND' && <button className="control-button primary" onClick={connect}><Icon name="link" />连接 {deviceName}</button>}
            {linkState === 'CONNECTING' && <button className="control-button" disabled><span className="spinner" />建立 GATT 连接…</button>}
            {linkError && <p className="connection-error"><Icon name="alert" size={14} />{linkError}</p>}
            {linkState === 'CONNECTED' && (
              <>
                <div className="device-facts">
                  <span><small>设备</small><b>{deviceName}</b></span>
                  <span><small>服务</small><b>FFF0</b></span>
                  <span><small>通知</small><b>FFF2 已开启</b></span>
                </div>
                <details className="gatt-console">
                  <summary className="gatt-console-head">
                    <span>原始 GATT 通道</span>
                    <b>{rawFrameCount} 通知 / {protocolPacketCount} 包</b>
                  </summary>
                  <div className="gatt-console-body">
                    <label htmlFor="raw-command">向 FFF1 写入十六进制命令</label>
                    <div className="gatt-command-row">
                      <input
                        id="raw-command"
                        value={commandHex}
                        placeholder="例如 AA 01 00 FF"
                        spellCheck={false}
                        onChange={(event) => setCommandHex(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void sendRawCommand()
                        }}
                      />
                      <button onClick={() => void sendRawCommand()}>发送</button>
                    </div>
                    <details className="gatt-frame">
                      <summary>FFF2 最后通知</summary>
                      <code>{lastRawFrame || '等待设备返回数据…'}</code>
                    </details>
                    <div className="decoded-sensor">
                      <div className="decoded-sensor-head">
                        <span>协议流拆包</span>
                        <b>{decodedSensorPacket ? `命令 0x${decodedSensorPacket.command.toString(16).padStart(2, '0').toUpperCase()}` : '等待数据'}</b>
                      </div>
                      {decodedSensorPacket ? (
                        <>
                          <div className="packet-meta">
                            <span>声明长度 <b>{decodedSensorPacket.declaredLength}</b></span>
                            <span>总字节 <b>{decodedSensorPacket.actualLength}</b></span>
                            <span>数据 <b>{decodedSensorPacket.payload.length}</b></span>
                            <span>校验 <b>0x{decodedSensorPacket.checksum.toString(16).padStart(2, '0').toUpperCase()}</b></span>
                          </div>
                          <div className="packet-payload">
                            <small>可变长度数据区</small>
                            <code>{decodedSensorPacket.payload.map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ') || '空'}</code>
                          </div>
                          {decodedSensorPacket.sensorData && (
                            <div className="decoded-sensor-grid">
                              <span><small>压力</small><b>{decodedSensorPacket.sensorData.pressurePa.toFixed(4)} Pa</b></span>
                              <span><small>温度</small><b>{decodedSensorPacket.sensorData.temperatureC.toFixed(2)} °C</b></span>
                              <span><small>压力原始值 WW</small><b>{decodedSensorPacket.sensorData.pressureRaw}</b></span>
                              <span><small>温度原始值 XX</small><b>{decodedSensorPacket.sensorData.temperatureRaw}</b></span>
                              <span><small>压力除数 YY</small><b>{decodedSensorPacket.sensorData.pressureDivisor}</b></span>
                            </div>
                          )}
                          <p>最近通知拆出 {lastSplitCount} 包，缓存中还有 {protocolBuffer.current.length} 字节等待下次拼接。</p>
                        </>
                      ) : (
                        <p>按 FB · 长度 · 命令 · 可变数据 · checksum 拆分，半包会自动缓存。</p>
                      )}
                    </div>
                  </div>
                </details>
                <button className="control-button danger-text" onClick={disconnect}>断开连接</button>
              </>
            )}
          </section>

          <section className="debug-panel">
            <div className="panel-label"><span>02</span> 测试用例</div>
            <div className="case-field-heading">
              <label className="field-label" htmlFor="test-case">训练用例</label>
              <button onClick={openNewCaseDialog} disabled={runState === 'RUNNING'}>＋ 新增用例</button>
            </div>
            <select id="test-case" value={selectedCaseId} disabled={runState === 'RUNNING'} onChange={(event) => selectTestCase(event.target.value)}>
              {testCases.map((item) => <option key={item.id} value={item.id}>{item.code} · {item.name}</option>)}
            </select>
            <div className="case-summary">
              <span className="case-id">{selectedCase.id}</span>
              <b>{selectedCase.name}</b>
              <p>{selectedCase.description}</p>
            </div>
            <button className="control-button primary" disabled={linkState !== 'CONNECTED' || runState === 'RUNNING'} onClick={loadScenario}>
              {scenarioLoaded ? <><Icon name="check" />重新加载用例</> : <>加载测试用例<Icon name="chevron" /></>}
            </button>
          </section>

          <section className="debug-panel">
            <div className="panel-label"><span>03</span> 故障注入</div>
            <label className="toggle-row">
              <div><b>数据包丢失</b><small>将传感器帧标记为丢失</small></div>
              <input type="checkbox" checked={packetLoss} onChange={(event) => {
                setPacketLoss(event.target.checked)
                addLog('WARN', 'FAULT_TOGGLE', { packet_loss: event.target.checked })
              }} />
              <i />
            </label>
            <label className="toggle-row">
              <div><b>传感器噪声</b><small>±0.45 L/min 随机抖动</small></div>
              <input type="checkbox" checked={sensorNoise} onChange={(event) => setSensorNoise(event.target.checked)} />
              <i />
            </label>
            <button className="fault-button" onClick={injectPressureSpike}><Icon name="alert" />注入压力峰值</button>
          </section>
        </aside>

        <div className="workspace">
          <section className="debug-panel config-panel">
            <div className="config-title">
              <div><div className="panel-label"><span>参数</span> 用例参数</div><b>{selectedCase.code}</b></div>
              <span className={scenarioLoaded ? 'config-synced synced' : 'config-synced'}>{scenarioLoaded ? '● 已同步' : '○ 未加载'}</span>
            </div>
            <p className="config-help">吸气或呼气流量只有连续大于对应阈值才计时；中断后，本阶段从 0 重新计算。</p>
            <div className="sequence-config custom-sequence">
              <span>动作顺序与独立参数</span>
              <div className="sequence-steps action-cards">
                {actions.map((action, index) => (
                  <div className={`sequence-step action-config-card ${action.direction === 'INHALE' ? 'inhale' : 'exhale'}`} key={action.id}>
                    {index > 0 && <i className="action-arrow">→</i>}
                    <div className="action-card-head">
                      <button disabled={runState === 'RUNNING'} onClick={() => toggleSequenceStep(index)} title="点击切换吸气/呼气">
                        <b>{index + 1}</b>{action.direction === 'INHALE' ? '吸气' : '呼气'}
                      </button>
                      {actions.length > 1 && <button className="remove-step" disabled={runState === 'RUNNING'} onClick={() => removeSequenceStep(index)} aria-label={`删除第 ${index + 1} 个动作`}>×</button>}
                    </div>
                    <div className="action-settings">
                      <label>
                        <span>动作时长</span>
                        <div><input type="number" min="0.5" max="60" step="0.5" value={action.duration} disabled={runState === 'RUNNING'} onChange={(event) => updateActionValue(index, 'duration', Number(event.target.value))} /><small>秒</small></div>
                      </label>
                      <label>
                        <span>{action.direction === 'INHALE' ? '吸气后屏息' : '呼气后停顿'}</span>
                        <div><input type="number" min="0" max="60" step="0.5" value={action.holdDuration} disabled={runState === 'RUNNING'} onChange={(event) => updateActionValue(index, 'holdDuration', Number(event.target.value))} /><small>秒</small></div>
                      </label>
                      <label>
                        <span>流量阈值</span>
                        <div><input type="number" min="0" max="1000" step="1" value={action.threshold} disabled={runState === 'RUNNING'} onChange={(event) => updateActionValue(index, 'threshold', Number(event.target.value))} /><small>L/min</small></div>
                      </label>
                    </div>
                  </div>
                ))}
              </div>
              <div className="sequence-add">
                <button disabled={runState === 'RUNNING' || actions.length >= 8} onClick={() => addAction('INHALE')}>＋ 吸气</button>
                <button disabled={runState === 'RUNNING' || actions.length >= 8} onClick={() => addAction('EXHALE')}>＋ 呼气</button>
              </div>
              <small>每个动作可独立设置时长、动作后等待时间和流量阈值；等待设为 0 秒可跳过。</small>
            </div>
            <div className="config-footer">
              <span>动作数 <b>{actions.length}</b> · 序列总时长 <b>{formatTime(totalDuration)}</b></span>
              <button onClick={loadScenario} disabled={linkState !== 'CONNECTED' || runState === 'RUNNING'}>
                <Icon name={scenarioLoaded ? 'check' : 'refresh'} />{scenarioLoaded ? '参数已应用' : '应用参数到测试用例'}
              </button>
            </div>
          </section>

          <section className="debug-panel emulator-panel">
            <div className="emulator-head">
              <div>
                <div className="panel-label"><span>运行</span> 训练流程模拟器</div>
                <h2>节律呼吸状态机</h2>
              </div>
              <div className="run-meta">
                <StateTag value={runState} />
                <span>动作 <b>{currentAction}/{actions.length}</b></span>
                <span>用时 <b>{formatTime(elapsed)} / {formatTime(totalDuration)}</b></span>
              </div>
            </div>

            <div className="emulator-body">
              <div className="phase-machine">
                <svg viewBox="0 0 240 240" className="phase-ring">
                  <circle cx="120" cy="120" r="108" className="ring-track" />
                  <circle
                    cx="120"
                    cy="120"
                    r="108"
                    className="ring-progress"
                    pathLength="100"
                    style={{ stroke: phase.color, strokeDashoffset: 100 - phase.progress * 100 }}
                  />
                </svg>
                <div className="phase-core" style={{ '--phase': phase.color } as React.CSSProperties}>
                  <span>当前阶段</span>
                  <strong>{runState === 'IDLE' ? '等待开始' : runState === 'ABORTED' ? '测试已中止' : phase.label}</strong>
                  <b>{runState === 'RUNNING' ? `${phase.remaining.toFixed(1)} 秒` : '—'}</b>
                </div>
                <div className="phase-nodes">
                  {orderedPhases.map((item, index) => (
                    <span className={phase.sequenceIndex === index && runState === 'RUNNING' ? 'active' : ''} key={`${item.actionId}-${item.key}`}>
                      <i style={{ background: item.color }} />{item.short}
                    </span>
                  ))}
                </div>
              </div>

              <div className="sensor-emulator">
                <div className="sensor-title">
                  <span>{hasRealSensorInput ? 'SDP800 流量输入' : '手动流量输入'}</span>
                  <small>{hasRealSensorInput ? '压力 1:1 映射' : '模拟调试'}</small>
                </div>
                <div className={`signed-effort-control direction-${inputDirection.toLowerCase()}`}>
                  <div className="signed-effort-labels">
                    <span className={inputDirection === 'INHALE' ? 'active' : ''}><i className="inhale-channel" />吸气</span>
                    <b>{inputDirectionLabel} {activeEffort.toFixed(2)} L/min</b>
                    <span className={inputDirection === 'EXHALE' ? 'active' : ''}>呼气<i className="exhale-channel" /></span>
                  </div>
                  <div className="signed-effort-bar">
                    <div className="signed-track">
                      <span className="inhale-fill" style={{ width: `${displayedInput < 0 ? Math.abs(displayedInput) / 2 : 0}%` }} />
                      <i />
                      <span className="exhale-fill" style={{ width: `${displayedInput > 0 ? displayedInput / 2 : 0}%` }} />
                    </div>
                    <input
                      aria-label="呼吸流量输入"
                      type="range"
                      min="-100"
                      max="100"
                      value={displayedInput}
                      disabled={hasRealSensorInput}
                      onChange={(event) => setBreathInput(Number(event.target.value))}
                    />
                  </div>
                  <div className="dual-effort-scale"><span>100</span><span>50</span><b>0</b><span>50</span><span>100</span></div>
                  <p><span>← 负压吸气</span><span>正压呼气 →</span></p>
                </div>
                <div className={`qualification-status ${phaseQualified ? 'qualified' : 'waiting'}`}>
                  <span>{phaseQualified ? <Icon name="check" size={13} /> : <Icon name="alert" size={13} />}</span>
                  <div><b>{qualificationText}</b><small>{isBreathPhase ? `阈值 ${requiredThreshold} L/min · 本次已重置 ${attemptResets} 次` : '屏息与停顿阶段无需流量判定'}</small></div>
                </div>
                <div className="sensor-values">
                  <div className={packetLoss ? 'faulted' : ''}><span>实时流量</span><b>{packetLoss ? '丢包' : flow.toFixed(2)}</b><small>L/min</small></div>
                  <div className={pressureAlarm ? 'alarm' : ''}><span>传感器压力</span><b>{pressure.toFixed(2)}</b><small>Pa</small></div>
                  <div><span>预估潮气量</span><b>{volume}</b><small>mL</small></div>
                </div>
                <div className="transport-controls">
                  {runState !== 'RUNNING' ? (
                    <button className="run-button" onClick={start} disabled={!scenarioLoaded || linkState !== 'CONNECTED'}><Icon name="play" />{runState === 'PAUSED' ? '继续运行' : '开始测试'}</button>
                  ) : (
                    <button className="run-button pause" onClick={pause}><Icon name="pause" />暂停测试</button>
                  )}
                  <button onClick={abort} disabled={runState === 'IDLE'}><Icon name="stop" />中止</button>
                </div>
              </div>
            </div>
          </section>

          <section className="debug-panel chart-panel">
            <div className="chart-head">
              <div className="panel-label"><span>波形</span> 传感器数据流</div>
              <div><span><i className="flow-color" />流量</span><span><i className="pressure-color" />压力</span><small>5 Hz 显示 / 1 Hz 日志</small></div>
            </div>
            <svg viewBox="0 0 800 170" preserveAspectRatio="none" aria-label="传感器数据波形">
              {[25, 55, 85, 115, 145].map((y) => <line key={y} x1="0" x2="800" y1={y} y2={y} />)}
              <path d={chartPath('flow', 100)} className="flow-path" />
              <path d={chartPath('pressure', 100)} className="pressure-path" />
            </svg>
          </section>
        </div>

        <aside className="inspector">
          <section className="debug-panel">
            <div className="panel-label"><span>状态</span> 状态查看器</div>
            <pre>{JSON.stringify(stateSnapshot, null, 2)}</pre>
          </section>

          <section className="debug-panel assertions">
            <div className="panel-label"><span>断言</span> 实时检查项</div>
            {[
              ['设备握手完成', linkState === 'CONNECTED'],
              ['测试用例已加载', scenarioLoaded],
              ['动作参数合法', actions.every((action) => action.duration >= 0.5 && action.holdDuration >= 0 && action.threshold >= 0)],
              ['当前输入达到阈值', !isBreathPhase || phaseQualified],
              ['传感器帧有效', !packetLoss],
              ['流量输入有效', Number.isFinite(inputFlow)],
              ['训练完整结束', runState === 'COMPLETED'],
            ].map(([label, passed]) => (
              <div className={passed ? 'assert-row passed' : 'assert-row'} key={String(label)}>
                <span>{passed ? <Icon name="check" size={12} /> : '—'}</span>
                <b>{String(label)}</b>
                <small>{passed ? '通过' : '等待'}</small>
              </div>
            ))}
          </section>

          <section className="debug-panel packet-panel">
            <div className="panel-label"><span>数据包</span> 最新传感器帧</div>
            <div className="hex-line"><span>7E</span><span>01</span><span>{phase.key === 'INHALE' ? 'A1' : phase.key === 'EXHALE' ? 'B1' : 'C0'}</span><span>{Math.abs(Math.round(flow)).toString(16).padStart(2, '0').toUpperCase()}</span><span>{Math.round(pressure).toString(16).padStart(2, '0').toUpperCase()}</span><span>0D</span></div>
            <div className="packet-fields">
              <span>帧头</span><span>类型</span><span>阶段</span><span>流量</span><span>压力</span><span>帧尾</span>
            </div>
          </section>
        </aside>
      </main>

      <section className="console-panel">
        <div className="console-head">
          <div><Icon name="terminal" /><b>事件日志</b><span>{logs.length} 条事件</span></div>
          <div>
            <button onClick={() => addLog('INFO', 'LOG_EXPORT_REQUESTED')}><Icon name="download" />导出</button>
            <button onClick={() => setLogs([])}><Icon name="trash" />清空</button>
          </div>
        </div>
        <div className="log-table">
          <div className="log-row log-header"><span>时间</span><span>方向</span><span>事件标识</span><span>原始数据</span></div>
          {[...logs].reverse().map((log) => (
            <div className="log-row" key={log.id}>
              <span>{log.time}</span>
              <span className={`log-level ${log.level.toLowerCase()}`}>{levelLabels[log.level]}</span>
              <span>{log.event}</span>
              <code>{log.payload}</code>
            </div>
          ))}
        </div>
      </section>

      {showNewCase && (
        <div className="case-modal-backdrop" onMouseDown={() => setShowNewCase(false)}>
          <form className="case-modal" onSubmit={(event) => { event.preventDefault(); createTestCase() }} onMouseDown={(event) => event.stopPropagation()}>
            <div className="case-modal-head">
              <div><span>新增测试用例</span><h2>创建自定义训练流程</h2></div>
              <button type="button" onClick={() => setShowNewCase(false)} aria-label="关闭">×</button>
            </div>
            <p>新用例将复制当前动作序列、阶段时间和流量阈值，创建后可继续修改参数。</p>
            <label>
              <span>用例名称</span>
              <input autoFocus value={newCaseName} onChange={(event) => setNewCaseName(event.target.value)} placeholder="例如：短吸长呼测试" maxLength={30} />
            </label>
            <label>
              <span>用例标识</span>
              <input value={newCaseCode} onChange={(event) => setNewCaseCode(event.target.value)} placeholder="例如：CUSTOM_002" maxLength={24} />
              {newCaseCodeExists && <small className="case-error">该标识已存在，请更换。</small>}
            </label>
            <div className="case-clone-summary">
              <span>复制当前参数</span>
              <b>{actions.map((action) => action.direction === 'INHALE' ? '吸气' : '呼气').join(' → ')}</b>
              {actions.map((action, index) => (
                <b key={action.id}>{index + 1}. {action.direction === 'INHALE' ? '吸气' : '呼气'} {action.duration} 秒 · 等待 {action.holdDuration} 秒 · 阈值 {action.threshold} L/min</b>
              ))}
            </div>
            <div className="case-modal-actions">
              <button type="button" onClick={() => setShowNewCase(false)}>取消</button>
              <button type="submit" disabled={!newCaseName.trim() || !normalizedNewCaseCode || newCaseCodeExists}>创建用例</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}

export default App
