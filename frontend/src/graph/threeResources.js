import * as THREE from 'three';

const spriteCache = new Map();

export function makeTextSprite(text, color) {
    const key = `${text}::${color}`;
    if (spriteCache.has(key)) return spriteCache.get(key).clone();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const fontSize = 48;
    ctx.font = `600 ${fontSize}px sans-serif`;
    const metrics = ctx.measureText(text);
    canvas.width = Math.ceil(metrics.width) + 16;
    canvas.height = fontSize + 16;
    ctx.font = `600 ${fontSize}px sans-serif`;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 8, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(canvas.width / 24, canvas.height / 24, 1);
    spriteCache.set(key, sprite);
    return sprite.clone();
}

export function clearTextSpriteCache() {
    for (const sprite of spriteCache.values()) {
        sprite.material?.map?.dispose?.();
        sprite.material?.dispose?.();
    }
    spriteCache.clear();
}

export function disposeResourceMap(resources) {
    for (const resource of Object.values(resources || {})) resource?.dispose?.();
}
