/**
 * WebGL utility functions for handling WebGL context management and error handling
 */

/**
 * Check if WebGL is supported in the current browser
 */
export function isWebGLSupported(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    return !!gl;
  } catch (e) {
    return false;
  }
}

/**
 * Check if WebGL2 is supported in the current browser
 */
export function isWebGL2Supported(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    return !!gl;
  } catch (e) {
    return false;
  }
}

/**
 * Get the maximum number of WebGL contexts that can be created
 */
export function getMaxWebGLContexts(): number {
  // Most browsers limit to 16 contexts, but we should be conservative
  return 8;
}

/**
 * Track active WebGL contexts to prevent memory issues
 */
class WebGLContextTracker {
  private activeContexts = new Set<string>();
  private contextCount = 0;

  addContext(id: string): boolean {
    if (this.contextCount >= getMaxWebGLContexts()) {
      console.warn('Maximum WebGL contexts reached. Consider reusing contexts or reducing the number of 3D components.');
      return false;
    }
    this.activeContexts.add(id);
    this.contextCount++;
    return true;
  }

  removeContext(id: string): void {
    if (this.activeContexts.has(id)) {
      this.activeContexts.delete(id);
      this.contextCount--;
    }
  }

  getContextCount(): number {
    return this.contextCount;
  }
}

export const webGLContextTracker = new WebGLContextTracker();

/**
 * Handle WebGL context loss
 */
export function handleWebGLContextLoss(
  canvas: HTMLCanvasElement,
  onContextLost?: () => void,
  onContextRestored?: () => void
): () => void {
  const handleContextLost = (event: Event) => {
    event.preventDefault();
    console.warn('WebGL context lost');
    onContextLost?.();
  };

  const handleContextRestored = () => {
    console.log('WebGL context restored');
    onContextRestored?.();
  };

  canvas.addEventListener('webglcontextlost', handleContextLost);
  canvas.addEventListener('webglcontextrestored', handleContextRestored);

  // Return cleanup function
  return () => {
    canvas.removeEventListener('webglcontextlost', handleContextLost);
    canvas.removeEventListener('webglcontextrestored', handleContextRestored);
  };
}

/**
 * Safe WebGL renderer creation with error handling
 */
export function createWebGLRenderer(options?: {
  antialias?: boolean;
  alpha?: boolean;
  preserveDrawingBuffer?: boolean;
  powerPreference?: 'high-performance' | 'low-power' | 'default';
}): WebGLRenderingContext | null {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl', options) as WebGLRenderingContext | null || 
               canvas.getContext('experimental-webgl', options) as WebGLRenderingContext | null;
    return gl;
  } catch (error) {
    console.error('Failed to create WebGL context:', error);
    return null;
  }
}

/**
 * Get WebGL error message for users
 */
export function getWebGLErrorMessage(): string {
  if (!isWebGLSupported()) {
    return 'Your browser does not support WebGL. Please try a different browser or update your current one.';
  }
  
  if (webGLContextTracker.getContextCount() >= getMaxWebGLContexts()) {
    return 'Too many 3D components are active. Please refresh the page or close some 3D views.';
  }
  
  return 'Unable to initialize 3D graphics. Please refresh the page or try a different browser.';
}