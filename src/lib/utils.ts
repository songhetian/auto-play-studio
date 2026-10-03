import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn/ui 的标准工具函数：条件类名 + 冲突类名后写覆盖前写 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
