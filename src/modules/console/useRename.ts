import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useInstanceStore } from '@/stores/instanceStore'

/**
 * 改名。
 *
 * 先本地生效、后台再同步：改名是「顺手改个称呼」这种轻操作，让用户等一次网络往返
 * 才看到新名字会显得卡。失败时再回滚到旧名并抛出，交给调用方提示。
 */
export function useRename() {
  const qc = useQueryClient()
  const renameLocal = useInstanceStore((s) => s.rename)

  return useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.rename(id, name),
    onMutate: async ({ id, name }) => {
      const prev = useInstanceStore.getState().instances[id]?.name
      renameLocal(id, name)
      return { prev }
    },
    onError: (_err, { id }, ctx) => {
      // 同步失败要把名字退回去，否则界面会一直显示一个引擎并不认的名字
      if (ctx?.prev !== undefined) renameLocal(id, ctx.prev)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['instances'] })
    },
  })
}
