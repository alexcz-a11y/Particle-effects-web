// Use WebGPU version of Three.js (includes TSL)
import * as THREE from 'three/webgpu';
import { reflector, color, pass, positionLocal, length, smoothstep, float, fract, step, max } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';

// Configuration
const PARTICLE_COUNT = 3000;      // Balanced particle count
const SPHERE_RADIUS = 2.5;
const DISPERSION_FACTOR = 15;     // Moderate dispersion
const LERP_SPEED = 0.05;

// Global Variables
let scene, camera, renderer, postProcessing;
let particles, particleGeometry;
let roomGroup; // Container for the entire room - rotates with hand
let targetPositions = []; 
let dispersedPositions = []; 
let isHandClosed = true; 
let isHandDetected = false;
let targetRotationX = 0;
let targetRotationY = 0;

// MediaPipe Setup
const videoElement = document.getElementById('video-element');
const loadingElement = document.getElementById('loading');

async function init() {
    await initThreeJS(); // Now async for WebGPU
    initLights(); // Add lighting for realistic rendering
    initRoom(); // Create reflective room first
    initParticles();
    // Add particles to the room group so they rotate together
    roomGroup.add(particles);
    initMediaPipe();
    animate();
}


// Cached particle glow texture
let particleTexture = null;

function getTexture() {
    if (particleTexture) return particleTexture;
    
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.2, 'rgba(200, 240, 255, 1)');
    gradient.addColorStop(0.4, 'rgba(0, 150, 255, 0.9)');
    gradient.addColorStop(0.6, 'rgba(0, 100, 255, 0.5)');
    gradient.addColorStop(0.8, 'rgba(0, 50, 255, 0.2)');
    gradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    
    particleTexture = new THREE.CanvasTexture(canvas);
    return particleTexture;
}

async function initThreeJS() {
    const container = document.getElementById('canvas-container');

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x000005); // Pure dark background

    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 6, 12); // Lift camera up to y=6
    camera.lookAt(0, 0, 0);

    // Create WebGPU Renderer (three/webgpu includes WebGPURenderer as default)
    renderer = new THREE.WebGPURenderer({ antialias: true });
    await renderer.init();
    console.log('✅ WebGPU Renderer initialized (M-chip native GPU)');
    
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 2.0; // High exposure for bright particles
    container.appendChild(renderer.domElement);

    // POST-PROCESSING (Bloom) using TSL - Strong glow from particles
    const scenePass = pass(scene, camera);
    const scenePassColor = scenePass.getTextureNode('output');
    const bloomPass = bloom(scenePassColor);
    // Configure bloom parameters
    bloomPass.threshold.value = 0.15; // Lower threshold slightly to catch more particle glow
    bloomPass.strength.value = 3.5;   // Stronger glow
    bloomPass.radius.value = 0.8;     // Soft glow
    postProcessing = new THREE.PostProcessing(renderer);
    postProcessing.outputNode = scenePassColor.add(bloomPass);

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
}

// Minimal ambient light - particles are the light source
function initLights() {
    // Almost pitch black ambient light
    const ambientLight = new THREE.AmbientLight(0x020205, 0.1);
    scene.add(ambientLight);
}

function initParticles() {
    particleGeometry = new THREE.BufferGeometry();
    const positions = new Float32Array(PARTICLE_COUNT * 3);
    const colors = new Float32Array(PARTICLE_COUNT * 3);
    const uvs = new Float32Array(PARTICLE_COUNT * 2); // Add UVs for WebGPU compatibility
    
    const phi = Math.PI * (3 - Math.sqrt(5)); 

    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const y = 1 - (i / (PARTICLE_COUNT - 1)) * 2; 
        const radiusAtY = Math.sqrt(1 - y * y);
        const theta = phi * i;

        const x = Math.cos(theta) * radiusAtY;
        const z = Math.sin(theta) * radiusAtY;

        // Scale to sphere radius with volumetric randomness
        // Radius varies between SPHERE_RADIUS * 0.9 and SPHERE_RADIUS * 1.1
        const r = SPHERE_RADIUS + (Math.random() - 0.5) * 0.4;
        const px = x * r;
        const py = y * r;
        const pz = z * r;

        positions[i * 3] = px;
        positions[i * 3 + 1] = py;
        positions[i * 3 + 2] = pz;

        targetPositions.push(new THREE.Vector3(px, py, pz));
        
        // Create a volumetric dispersion with HIGHER DENSITY IN CENTER
        // Use Gaussian-like distribution instead of uniform
        const u = Math.random();
        const v = Math.random();
        const theta_rand = 2 * Math.PI * u;
        const phi_rand = Math.acos(2 * v - 1);
        
        // Bias randomness towards center: lower power = more center bias
        // Math.random() * Math.random() * Math.random() creates strong center bias
        const r_rand = (Math.random() * Math.random()) * DISPERSION_FACTOR; 
        
        const sinPhi = Math.sin(phi_rand);
        const dx = r_rand * sinPhi * Math.cos(theta_rand);
        const dy = r_rand * sinPhi * Math.sin(theta_rand);
        const dz = r_rand * Math.cos(phi_rand);
        
        dispersedPositions.push(new THREE.Vector3(dx, dy, dz));
        
        // Deep Blue theme - HDR colors (values > 1.0 for intense glow)
        // R: 0.0 - 0.2
        // G: 0.5 - 1.5 (mid-high green/cyan)
        // B: 1.5 - 3.0 (very strong blue)
        colors[i * 3] = Math.random() * 0.2;
        colors[i * 3 + 1] = 0.5 + Math.random() * 1.0; 
        colors[i * 3 + 2] = 1.5 + Math.random() * 1.5;
        
        // UV coordinates (not really used for points but needed for WebGPU)
        uvs[i * 2] = 0.5;
        uvs[i * 2 + 1] = 0.5;
    }

    particleGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    particleGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    particleGeometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

    const particleMaterial = new THREE.PointsMaterial({
        map: getTexture(), // Use generated glow texture
        size: 3.0,         // Much larger particles for visibility
        transparent: true,
        opacity: 1.0,      // Full opacity for maximum brightness
        vertexColors: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: false  // Keep same size regardless of distance
    });

    particles = new THREE.Points(particleGeometry, particleMaterial);
    // Particles will be added to roomGroup after it's created
}

function initRoom() {
    const roomSize = 40;
    const roomHeight = 20;
    
    // Create room group - entire space rotates together
    roomGroup = new THREE.Group();
    scene.add(roomGroup);
    
    // Floor reflector for real-time mirror reflection
    const groundReflector = reflector();
    
    // TSL calculations for floor material
    const dist = length(positionLocal.xz);
    const maxDist = float(roomSize / 2);
    const reflectionMask = smoothstep(maxDist.mul(0.8), maxDist, dist).oneMinus();
    
    // Procedural grid using TSL
    const gridSize = float(2.0);
    const lineWidth = float(0.05);
    const uv = positionLocal.xz.div(gridSize);
    const gridPos = fract(uv).sub(0.5).abs().mul(2.0);
    const gridLine = step(float(1.0).sub(lineWidth), max(gridPos.x, gridPos.y));
    const gridColor = color(0x002244);
    const gridFade = smoothstep(maxDist.mul(0.2), maxDist, dist).oneMinus().mul(0.2);
    const gridNode = gridColor.mul(gridLine).mul(gridFade);
    
    // Floor color: base + reflection + grid
    const baseColor = color(0x000205);
    const reflectionColor = groundReflector.mul(reflectionMask).mul(0.3);
    const floorColorNode = baseColor.add(reflectionColor).add(gridNode);
    
    // Floor mesh
    const floorGeometry = new THREE.PlaneGeometry(roomSize, roomSize);
    const floorMaterial = new THREE.MeshBasicNodeMaterial({ colorNode: floorColorNode });
    const floor = new THREE.Mesh(floorGeometry, floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -roomHeight / 2;
    floor.add(groundReflector.target);
    roomGroup.add(floor);
    
    // Wall material and geometries (reused)
    const wallMaterial = new THREE.MeshBasicMaterial({ color: 0x020208 });
    const ceilingGeometry = new THREE.PlaneGeometry(roomSize, roomSize);
    const wallGeometry = new THREE.PlaneGeometry(roomSize, roomHeight);
    
    // Ceiling
    const ceiling = new THREE.Mesh(ceilingGeometry, wallMaterial);
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = roomHeight / 2;
    roomGroup.add(ceiling);
    
    // Walls
    const backWall = new THREE.Mesh(wallGeometry, wallMaterial);
    backWall.position.z = -roomSize / 2;
    roomGroup.add(backWall);
    
    const frontWall = new THREE.Mesh(wallGeometry, wallMaterial);
    frontWall.position.z = roomSize / 2;
    frontWall.rotation.y = Math.PI;
    roomGroup.add(frontWall);
    
    const leftWall = new THREE.Mesh(wallGeometry, wallMaterial);
    leftWall.rotation.y = Math.PI / 2;
    leftWall.position.x = -roomSize / 2;
    roomGroup.add(leftWall);
    
    const rightWall = new THREE.Mesh(wallGeometry, wallMaterial);
    rightWall.rotation.y = -Math.PI / 2;
    rightWall.position.x = roomSize / 2;
    roomGroup.add(rightWall);
}

function initMediaPipe() {
    // Access global Hands object
    const hands = new window.Hands({locateFile: (file) => {
        return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
    }});

    hands.setOptions({
        maxNumHands: 1,
        modelComplexity: 1,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
    });

    hands.onResults(onHandsResults);

    const cameraUtils = new window.Camera(videoElement, {
        onFrame: async () => {
            await hands.send({image: videoElement});
        },
        width: 640,
        height: 480
    });

    cameraUtils.start()
        .then(() => {
            console.log("Camera started");
            loadingElement.style.display = 'none';
        })
        .catch(err => {
            console.error("Camera failed", err);
            loadingElement.innerText = "Camera access denied or failed.";
        });
}

function onHandsResults(results) {
    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        isHandDetected = true;
        const landmarks = results.multiHandLandmarks[0];

        const thumbTip = landmarks[4];
        const indexTip = landmarks[8];
        const wrist = landmarks[0];
        const middleMCP = landmarks[9];

        const dx = thumbTip.x - indexTip.x;
        const dy = thumbTip.y - indexTip.y;
        const dz = thumbTip.z - indexTip.z;
        const tipDistance = Math.sqrt(dx*dx + dy*dy + dz*dz);

        const rx = wrist.x - middleMCP.x;
        const ry = wrist.y - middleMCP.y;
        const rz = wrist.z - middleMCP.z;
        const refDistance = Math.sqrt(rx*rx + ry*ry + rz*rz);

        const ratio = tipDistance / refDistance;

        if (ratio > 0.3) {
            isHandClosed = false; 
        } else {
            isHandClosed = true; 
        }

        // Hand Position Rotation - larger range for more dramatic 3D effect
        const handX = middleMCP.x; 
        const handY = middleMCP.y; 

        targetRotationY = (handX - 0.5) * 3;  // Left-right rotation
        targetRotationX = (handY - 0.5) * 2;  // Up-down rotation (less range)

    } else {
        isHandDetected = false;
        isHandClosed = true; 
    }
}

function animate() {
    const now = performance.now();
    const time = now * 0.001;
    const positions = particleGeometry.attributes.position.array;

    // Rotate the entire room (including walls and particles) with hand gesture
    if (isHandDetected) {
        roomGroup.rotation.x += (targetRotationX - roomGroup.rotation.x) * LERP_SPEED;
        roomGroup.rotation.y += (targetRotationY - roomGroup.rotation.y) * LERP_SPEED;
    } else {
        // Auto-rotate slowly when no hand detected
        roomGroup.rotation.y += 0.003;
        roomGroup.rotation.x += (0 - roomGroup.rotation.x) * LERP_SPEED;
    }

    for (let i = 0; i < PARTICLE_COUNT; i++) {
        const currentX = positions[i * 3];
        const currentY = positions[i * 3 + 1];
        const currentZ = positions[i * 3 + 2];

        let targetX, targetY, targetZ;

        if (!isHandClosed) {
            // Dispersed - fill the entire space
            const dispersed = dispersedPositions[i];
            targetX = dispersed.x + Math.sin(time + i * 0.1) * 1.5;
            targetY = dispersed.y + Math.cos(time * 0.8 + i * 0.1) * 1.5;
            targetZ = dispersed.z + Math.sin(time * 0.5 + i * 0.2) * 1.5;
        } else {
            const sphere = targetPositions[i];
            targetX = sphere.x;
            targetY = sphere.y;
            targetZ = sphere.z;
        }

        positions[i * 3] += (targetX - currentX) * LERP_SPEED;
        positions[i * 3 + 1] += (targetY - currentY) * LERP_SPEED;
        positions[i * 3 + 2] += (targetZ - currentZ) * LERP_SPEED;
    }

    particleGeometry.attributes.position.needsUpdate = true;

    // Render with post-processing
    postProcessing.renderAsync();
}

// Start with setAnimationLoop for WebGPU
async function start() {
    await init();
    renderer.setAnimationLoop(animate);
}

start();
