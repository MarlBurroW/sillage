import { useQuery } from '@tanstack/react-query'
import type { InstanceCapabilities, InstanceInfo } from '@sillage/protocol'
import { api } from './api'

/**
 * Le profil de l'instance : serveur joint par un navigateur, ou application de bureau.
 *
 * Il ne change pas tant que le serveur tourne, d'où le cache sans fin. `App` l'attend
 * avec la session avant de dessiner quoi que ce soit, ce qui épargne aux écrans un état
 * « pas encore connu » : une action réservée au serveur n'apparaît pas une fraction de
 * seconde dans la fenêtre de bureau.
 */
export function useInstance() {
  return useQuery({
    queryKey: ['system', 'instance'],
    queryFn: () => api.get<InstanceInfo>('/api/system/instance'),
    staleTime: Infinity,
    retry: false,
  })
}

/**
 * Une capacité de l'instance. Tester celle-ci plutôt que le profil : voir
 * `InstanceCapabilities`.
 *
 * Tant que le profil n'est pas chargé, ou s'il n'a pas pu l'être, les capacités du
 * serveur font foi : c'est le déploiement historique, et un serveur plus ancien que
 * l'interface (le web déployé à chaud, sans redémarrage) ne connaît pas cette route.
 */
export function useCapability(name: keyof InstanceCapabilities): boolean {
  const { data } = useInstance()
  return data?.capabilities[name] ?? true
}
