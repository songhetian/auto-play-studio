import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { ImageAsset } from '@/lib/api'

/** 素材库的查询与变更都收在这里，选图器与素材库页共用，避免各自缓存打架 */

const KEY = ['images'] as const

export function useAssets(enabled = true) {
  return useQuery({ queryKey: KEY, queryFn: api.listImages, enabled })
}

/** 体检整库：引用了不存在的素材 / 素材文件丢了 */
export function useAssetAudit(enabled = true) {
  return useQuery({ queryKey: [...KEY, 'audit'], queryFn: api.auditImages, enabled })
}

function useRefresh() {
  const qc = useQueryClient()
  return () => {
    void qc.invalidateQueries({ queryKey: KEY })
    // 素材被增删改后，实例配置里的引用关系也可能变了
    void qc.invalidateQueries({ queryKey: ['instances'] })
  }
}

/** 截图默认名：带时间，导入多张后能区分 */
export function defaultShotName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `截图 ${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`
}

export function useUploadAsset() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: ({ file, name }: { file: File; name?: string }) => api.uploadImage(file, { name }),
    onSuccess: refresh,
  })
}

export function useCaptureAsset() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (region: { x: number; y: number; width: number; height: number; name?: string }) =>
      api.captureImage({ name: region.name ?? defaultShotName(), ...region }),
    onSuccess: refresh,
  })
}

export function useUpdateAsset() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { name?: string; tag?: string; threshold?: number } }) =>
      api.updateImage(id, patch),
    onSuccess: refresh,
  })
}

export function useDeleteAsset() {
  const refresh = useRefresh()
  return useMutation({
    // 被引用时后端回 409，api 层会抛 AssetInUseError，交给调用方弹确认框
    mutationFn: ({ id, force }: { id: string; force?: boolean }) => api.deleteImage(id, { force }),
    onSuccess: refresh,
  })
}

/** 视频抽帧：均匀抽成图像素材入库，成功後刷新素材库与实例引用 */
export function useExtractVideo() {
  const refresh = useRefresh()
  return useMutation({
    mutationFn: (file: File) => api.extractVideo(file),
    onSuccess: refresh,
  })
}

export type { ImageAsset }
