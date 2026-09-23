import {
  AmbientLight,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  LoadingManager,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Texture,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js'
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import { rawFileUrl } from './files-io'
import type { WorkspaceScope } from './workspace-scope'

/**
 * Visualiseur 3D : une scène three.js par onglet, rendue à la demande.
 *
 * Isolé de React pour que ce module, et `three` avec lui, ne soient chargés que
 * lorsqu'un modèle est ouvert : la bibliothèque pèse plus que tout le reste de
 * l'application. Le composant ne connaît que `load`, `fit`, `setGrid` et `dispose`.
 */

/**
 * Préfixe des ressources annexes d'un modèle (`.bin`, textures, `.mtl`).
 *
 * Les chargeurs de three.js construisent l'URL d'une ressource par concaténation
 * `chemin + nom`. Comme le chemin d'un fichier du workspace vit dans un paramètre de
 * requête, cette concaténation ne donne rien d'utilisable ; un préfixe reconnaissable
 * permet à `LoadingManager` de la remplacer par la vraie URL, à côté du fichier
 * principal.
 */
const RESOURCE_PREFIX = 'sillage-resource:'

export interface ModelStats {
  meshes: number
  triangles: number
}

export class ModelViewer {
  private readonly renderer: WebGLRenderer
  private readonly scene = new Scene()
  private readonly camera = new PerspectiveCamera(45, 1, 0.01, 1000)
  private readonly controls: OrbitControls
  private readonly manager: LoadingManager
  private model: Object3D | null = null
  private grid: GridHelper | null = null
  private gridVisible = true
  private observer: ResizeObserver | null = null
  private frame = 0
  private disposed = false

  constructor(private readonly host: HTMLElement, private readonly scope: WorkspaceScope, private readonly path: string) {
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    host.appendChild(this.renderer.domElement)

    this.scene.add(new HemisphereLight(0xffffff, 0x60606a, 1.8))
    this.scene.add(new AmbientLight(0xffffff, 0.3))
    const key = new DirectionalLight(0xffffff, 2)
    key.position.set(1, 2, 1.5)
    this.scene.add(key)
    const fill = new DirectionalLight(0xffffff, 0.6)
    fill.position.set(-2, 0.5, -1)
    this.scene.add(fill)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.addEventListener('change', () => this.requestRender())

    const directory = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''
    this.manager = new LoadingManager()
    this.manager.setURLModifier((url) => {
      if (!url.startsWith(RESOURCE_PREFIX)) return url
      let name = url.slice(RESOURCE_PREFIX.length)
      // Les URI d'un glTF sont encodées en pourcentage ; un nom d'`obj` ne l'est pas.
      try { name = decodeURIComponent(name) } catch { /* nom brut */ }
      return rawFileUrl(scope, directory + name)
    })

    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(host)
    this.resize()
  }

  /** Charge le fichier principal, en remplaçant le modèle courant s'il y en a un. */
  async load(): Promise<ModelStats> {
    const extension = this.path.slice(this.path.lastIndexOf('.') + 1).toLowerCase()
    const url = rawFileUrl(this.scope, this.path)
    const object = await this.loadObject(extension, url)
    if (this.disposed) {
      disposeObject(object)
      throw new Error('disposed')
    }
    this.clearModel()
    this.model = object
    this.scene.add(object)
    this.fit()
    return stats(object)
  }

  private async loadObject(extension: string, url: string): Promise<Object3D> {
    switch (extension) {
      case 'glb':
      case 'gltf': {
        const loader = new GLTFLoader(this.manager).setResourcePath(RESOURCE_PREFIX)
        const gltf = await loader.loadAsync(url)
        return gltf.scene
      }
      case 'obj': {
        const loader = new OBJLoader(this.manager)
        const object = await loader.loadAsync(url)
        // L'`obj` déclare ses matériaux dans un `.mtl` voisin : le premier trouvé s'applique.
        const library = (object as Group & { materialLibraries?: string[] }).materialLibraries?.[0]
        if (library) {
          const materials = await new MTLLoader(this.manager)
            .setResourcePath(RESOURCE_PREFIX)
            .loadAsync(RESOURCE_PREFIX + library)
            .catch(() => null)
          if (materials) {
            materials.preload()
            const withMaterials = await new OBJLoader(this.manager).setMaterials(materials).loadAsync(url)
            disposeObject(object)
            return withMaterials
          }
        }
        return object
      }
      case 'fbx': {
        const loader = new FBXLoader(this.manager).setResourcePath(RESOURCE_PREFIX)
        return await loader.loadAsync(url)
      }
      case 'stl': {
        const geometry = await new STLLoader(this.manager).loadAsync(url)
        geometry.computeVertexNormals()
        const material = new MeshStandardMaterial({ color: 0xb8bcc8, metalness: 0.1, roughness: 0.6 })
        const group = new Group()
        group.add(new Mesh(geometry, material))
        return group
      }
      default:
        throw new Error(`Unsupported model format: ${extension}`)
    }
  }

  /** Cadre la caméra sur le modèle entier et pose la grille sous lui. */
  fit(): void {
    if (!this.model) return
    const box = new Box3().setFromObject(this.model)
    if (box.isEmpty()) return
    const size = box.getSize(new Vector3())
    const center = box.getCenter(new Vector3())
    const radius = Math.max(size.x, size.y, size.z, 1e-3)

    const distance = (radius / 2) / Math.tan((this.camera.fov * Math.PI) / 360) * 1.5
    this.camera.near = Math.max(distance / 1000, 1e-4)
    this.camera.far = distance * 100
    this.camera.position.copy(center).add(new Vector3(0.7, 0.5, 1).normalize().multiplyScalar(distance))
    this.camera.updateProjectionMatrix()
    this.controls.target.copy(center)
    this.controls.minDistance = distance / 100
    this.controls.maxDistance = distance * 20
    this.controls.update()

    if (this.grid) {
      this.scene.remove(this.grid)
      this.grid.dispose()
    }
    const extent = radius * 2
    this.grid = new GridHelper(extent, 20, new Color(0x8a8f9c), new Color(0x5a5f6c))
    this.grid.position.set(center.x, box.min.y, center.z)
    this.grid.material.transparent = true
    this.grid.material.opacity = 0.35
    this.grid.visible = this.gridVisible
    this.scene.add(this.grid)
    this.requestRender()
  }

  setGrid(visible: boolean): void {
    this.gridVisible = visible
    if (this.grid) this.grid.visible = visible
    this.requestRender()
  }

  private resize(): void {
    const width = Math.max(1, this.host.clientWidth)
    const height = Math.max(1, this.host.clientHeight)
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.requestRender()
  }

  /** Rendu à la demande : une scène immobile ne coûte rien. */
  private requestRender(): void {
    if (this.frame || this.disposed) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.renderer.render(this.scene, this.camera)
    })
  }

  private clearModel(): void {
    if (!this.model) return
    this.scene.remove(this.model)
    disposeObject(this.model)
    this.model = null
  }

  /** Rend le contexte WebGL : le navigateur n'en accorde qu'une poignée par page. */
  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.observer?.disconnect()
    this.controls.dispose()
    this.clearModel()
    this.grid?.dispose()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
  }
}

function stats(object: Object3D): ModelStats {
  let meshes = 0
  let triangles = 0
  object.traverse((node) => {
    if (!(node instanceof Mesh)) return
    meshes += 1
    const geometry = node.geometry
    const count = geometry.index ? geometry.index.count : geometry.attributes.position?.count ?? 0
    triangles += Math.floor(count / 3)
  })
  return { meshes, triangles }
}

function disposeObject(object: Object3D): void {
  object.traverse((node) => {
    if (!(node instanceof Mesh)) return
    node.geometry?.dispose()
    const materials = Array.isArray(node.material) ? node.material : [node.material]
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) value.dispose()
      }
      material.dispose()
    }
  })
}
