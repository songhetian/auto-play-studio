import { MorphIcon } from 'morphicons/react'
import {
  Activity,
  ArrowRight,
  ArrowUpRight,
  Bell,
  BellRing,
  Boxes,
  Camera,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  CircleDot,
  CircleX,
  Clock,
  Command,
  Copy,
  Crop,
  Cpu,
  Database,
  Download,
  Ellipsis,
  ExternalLink,
  Eye,
  FileSpreadsheet,
  FileText,
  Filter,
  FolderOpen,
  Gauge,
  GitCompareArrows,
  HardDrive,
  Images,
  Info,
  Keyboard,
  Layers,
  LayoutDashboard,
  ListOrdered,
  Link2,
  Maximize2,
  Menu,
  Monitor,
  Moon,
  MoreVertical,
  MousePointerClick,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Pencil,
  Play,
  Plus,
  Power,
  RefreshCw,
  Rocket,
  Route,
  ScanEye,
  Search,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Square,
  StopCircle,
  Sun,
  Table2,
  Tag,
  Terminal,
  Timer,
  Trash2,
  TriangleAlert,
  Truck,
  Upload,
  Wand2,
  Wrench,
  X,
  Zap,
  type IconNode,
} from 'lucide'

/**
 * 图标体系（单一入口）。
 *
 * 用的是用户指定的 morphicons：同一个 <Icon> 在 name 变化时按弹性物理做形变，
 * 所以「展开/收起」「播放/暂停」这类状态切换不需要额外动画代码，图标自己会过渡。
 *
 * 图标形状来自 `lucide` 的**数据**包（IconNode），不是 `lucide-react` 的组件包 ——
 * MorphIcon 只吃数据。名称在这里一次映射完，页面里只写语义名（`name="play"`），
 * 换图标库时只改这一个文件。
 */
export const ICON_NODES = {
  /* 导航：分组与条目 */
  dashboard: LayoutDashboard,
  instances: Layers,
  rpa: MousePointerClick,
  monitor: ScanEye,
  logi: Truck,
  cmp: GitCompareArrows,
  macro: ListOrdered,
  assets: Images,
  settings: Settings2,

  /* 外壳与导航交互 */
  search: Search,
  close: X,
  menu: Menu,
  chevronRight: ChevronRight,
  chevronDown: ChevronDown,
  chevronUp: ChevronUp,
  chevronLeft: ChevronLeft,
  panelOpen: PanelLeftOpen,
  panelClose: PanelLeftClose,
  sun: Sun,
  moon: Moon,
  system: Monitor,
  command: Command,

  /* 动作 */
  plus: Plus,
  copy: Copy,
  trash: Trash2,
  play: Play,
  pause: Pause,
  stop: Square,
  stopCircle: StopCircle,
  refresh: RefreshCw,
  pencil: Pencil,
  check: Check,
  upload: Upload,
  download: Download,
  crop: Crop,
  camera: Camera,
  externalLink: ExternalLink,
  maximize: Maximize2,
  more: Ellipsis,
  moreVertical: MoreVertical,
  filter: Filter,
  eye: Eye,
  arrowRight: ArrowRight,
  arrowUpRight: ArrowUpRight,
  power: Power,
  rocket: Rocket,
  wand: Wand2,
  zap: Zap,
  sliders: SlidersHorizontal,
  sparkles: Sparkles,

  /* 状态与信息 */
  info: Info,
  warning: TriangleAlert,
  error: CircleX,
  success: CircleCheck,
  dot: CircleDot,
  bell: Bell,
  bellRing: BellRing,
  shield: ShieldCheck,
  wrench: Wrench,

  /* 资源与系统 */
  folder: FolderOpen,
  database: Database,
  drive: HardDrive,
  cpu: Cpu,
  activity: Activity,
  clock: Clock,
  timer: Timer,
  gauge: Gauge,
  keyboard: Keyboard,
  terminal: Terminal,
  route: Route,
  link: Link2,
  tag: Tag,
  fileText: FileText,
  sheet: FileSpreadsheet,
  table: Table2,
  boxes: Boxes,
} as const satisfies Record<string, IconNode>

export type IconName = keyof typeof ICON_NODES

export interface IconProps {
  name: IconName
  size?: number
  className?: string
  strokeWidth?: number
  /** 传了才成为可读元素（role="img" + <title>），否则 aria-hidden */
  label?: string
}

/**
 * 唯一的图标组件。静态用它是普通 SVG；`name` 变了就自动形变过渡。
 */
export function Icon({ name, size = 16, className, strokeWidth = 1.75, label }: IconProps) {
  return (
    <MorphIcon icon={ICON_NODES[name]} size={size} className={className} strokeWidth={strokeWidth} label={label} />
  )
}

export { MorphIcon }
