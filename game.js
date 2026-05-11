const CANVAS_SIZE = 800;

class Game {
    constructor() {
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');

        this.planes = [];
        this.missiles = [];
        this.flares = [];
        this.mountains = [];
        this.selectedPlane = null;
        this.gameState = 'planning'; // 'planning', 'action_phase', 'game_over'

        this.ai = new AIController(this);
        this.animations = [];
        this.actionPhaseProgress = 0;
        this.actionDuration = 90; // frames
        this.isDraggingWaypoint = false;

        this.recordedFrames = [];
        this.isReplaying = false;
        this.replayFrame = 0;
        this.smokeParticles = [];

        this.init();
        this.bindEvents();

        console.log("BRRT: Tactical Command System Online.");
        this.lastTime = 0;
        requestAnimationFrame(this.loop.bind(this));
    }

    init() {
        this.planes = [];
        this.missiles = [];
        this.flares = [];
        this.mountains = [];
        this.logMsg("AWACS: Picture clear. You are cleared to engage.", "log-system");

        // Random Mountains with big gaps
        let numMountains = 2 + Math.floor(Math.random() * 2); // 2 or 3 mountains
        for (let i = 0; i < numMountains; i++) {
            let placed = false;
            let attempts = 0;
            while (!placed && attempts < 50) {
                attempts++;
                let mx = 200 + Math.random() * 400; // Middle 400x400
                let my = 200 + Math.random() * 400;
                let mr = 40 + Math.random() * 30; // Radius 40 to 70

                let valid = true;
                for (let existing of this.mountains) {
                    if (dist(mx, my, existing.x, existing.y) < existing.radius + mr + 120) {
                        valid = false;
                        break;
                    }
                }
                if (valid) {
                    this.mountains.push(new Mountain(mx, my, mr));
                    placed = true;
                }
            }
        }

        // Player Planes
        this.planes.push(new Plane(300, 700, 'player', "A-10 Warthog"));
        this.planes.push(new Plane(500, 700, 'player', "F-22 Raptor"));

        // Enemy Planes
        this.planes.push(new Plane(300, 100, 'enemy', "MiG-29"));
        this.planes.push(new Plane(500, 100, 'enemy', "Su-57"));

        this.gameState = 'planning';
        this.selectedPlane = null;
        this.updateUI();
        document.getElementById('game-over-overlay').classList.add('hidden');
    }

    bindEvents() {
        this.canvas.addEventListener('mousedown', this.handleMouseDown.bind(this));
        this.canvas.addEventListener('mousemove', this.handleMouseMove.bind(this));
        this.canvas.addEventListener('mouseup', this.handleMouseUp.bind(this));
        this.canvas.addEventListener('mouseleave', this.handleMouseUp.bind(this));

        document.getElementById('btn-commit-turn').addEventListener('click', () => {
            if (this.gameState === 'planning') this.startActionPhase();
        });

        document.getElementById('btn-restart').addEventListener('click', () => this.init());

        document.getElementById('btn-replay').addEventListener('click', () => {
            if (this.gameState === 'planning' && this.recordedFrames.length > 0) {
                this.startReplay();
            }
        });

        // UI Listeners
        const flightRadios = document.querySelectorAll('input[name="flight"]');
        flightRadios.forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (this.selectedPlane) {
                    this.selectedPlane.planned.flightAction = e.target.value;
                    this.selectedPlane.planned.targetPos = null;
                    this.updateUI();
                }
            });
        });

        const weaponRadios = document.querySelectorAll('input[name="weapon"]');
        weaponRadios.forEach(radio => {
            radio.addEventListener('change', (e) => {
                if (this.selectedPlane) {
                    this.selectedPlane.planned.weapon = e.target.value;
                    if (e.target.value !== 'missile') this.selectedPlane.planned.missileTarget = null;
                    this.updateUI();
                }
            });
        });
    }

    handleMouseDown(e) {
        if (this.gameState !== 'planning') return;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Dragging existing waypoint
        if (this.selectedPlane && this.selectedPlane.planned.targetPos && this.selectedPlane.planned.flightAction !== 'turnaround') {
            if (dist(x, y, this.selectedPlane.planned.targetPos.x, this.selectedPlane.planned.targetPos.y) < 15) {
                this.isDraggingWaypoint = true;
                return;
            }
        }

        let clickedPlane = null;
        for (let p of this.planes) {
            if (p.team === 'player' && !p.isDestroyed && dist(x, y, p.x, p.y) <= p.radius * 2) {
                clickedPlane = p;
                break;
            }
        }

        if (clickedPlane) {
            this.selectPlane(clickedPlane);
            return;
        }

        if (this.selectedPlane) {
            if (this.selectedPlane.planned.flightAction === 'turnaround') {
                let angleToClick = normalizeAngle(Math.atan2(y - this.selectedPlane.y, x - this.selectedPlane.x) - this.selectedPlane.heading);
                this.selectedPlane.planned.turnDirection = Math.sign(angleToClick) || 1;
                this.selectedPlane.planned.targetPos = { x: this.selectedPlane.x, y: this.selectedPlane.y };
                this.updateUI();
                return;
            }

            if (this.selectedPlane.planned.weapon === 'missile') {
                for (let p of this.planes) {
                    if (p.team === 'enemy' && !p.isDestroyed && dist(x, y, p.x, p.y) <= p.radius * 2) {
                        if (this.selectedPlane.isValidMissileTarget(p)) {
                            this.selectedPlane.planned.missileTarget = p;
                            this.logMsg(`Radar lock acquired on bandit.`, "log-system");
                            this.updateUI();
                            return;
                        }
                    }
                }
            }

            if (this.selectedPlane.isValidWaypoint(x, y)) {
                let params = this.selectedPlane.getMoveParams();
                let angle = Math.atan2(y - this.selectedPlane.y, x - this.selectedPlane.x);
                let diff = normalizeAngle(angle - this.selectedPlane.heading);
                if (diff > params.turnAngle) angle = this.selectedPlane.heading + params.turnAngle;
                if (diff < -params.turnAngle) angle = this.selectedPlane.heading - params.turnAngle;

                this.selectedPlane.planned.targetPos = {
                    x: this.selectedPlane.x + Math.cos(angle) * params.maxDist,
                    y: this.selectedPlane.y + Math.sin(angle) * params.maxDist
                };
                this.isDraggingWaypoint = true;
                this.updateUI();
            }
        }
    }

    handleMouseMove(e) {
        if (this.gameState !== 'planning' || !this.isDraggingWaypoint || !this.selectedPlane) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (this.selectedPlane.isValidWaypoint(x, y)) {
            let params = this.selectedPlane.getMoveParams();
            let angle = Math.atan2(y - this.selectedPlane.y, x - this.selectedPlane.x);
            let diff = normalizeAngle(angle - this.selectedPlane.heading);
            if (diff > params.turnAngle) angle = this.selectedPlane.heading + params.turnAngle;
            if (diff < -params.turnAngle) angle = this.selectedPlane.heading - params.turnAngle;

            this.selectedPlane.planned.targetPos = {
                x: this.selectedPlane.x + Math.cos(angle) * params.maxDist,
                y: this.selectedPlane.y + Math.sin(angle) * params.maxDist
            };
        }
    }

    handleMouseUp() {
        if (this.isDraggingWaypoint) {
            this.isDraggingWaypoint = false;
            if (this.gameState === 'planning') this.updateUI();
        }
    }

    selectPlane(plane) {
        this.selectedPlane = plane;
        this.updateUI();
    }

    updateUI() {
        const infoPanel = document.getElementById('unit-info');

        if (this.selectedPlane && this.gameState === 'planning') {
            infoPanel.classList.remove('hidden');
            document.getElementById('ui-unit-name').innerText = this.selectedPlane.type;

            let hpPct = (this.selectedPlane.hp / this.selectedPlane.maxHp) * 100;
            document.getElementById('ui-hp-bar').style.width = `${hpPct}%`;
            document.getElementById('ui-hp-val').innerText = `${this.selectedPlane.hp}/${this.selectedPlane.maxHp}`;

            let enPct = (this.selectedPlane.energy / this.selectedPlane.maxEnergy) * 100;
            document.getElementById('ui-energy-bar').style.width = `${enPct}%`;
            document.getElementById('ui-energy-val').innerText = `${this.selectedPlane.energy}/${this.selectedPlane.maxEnergy}`;

            document.getElementById('ui-ammo-missile').innerText = this.selectedPlane.ammo.missiles;
            document.getElementById('ui-ammo-flares').innerText = this.selectedPlane.ammo.flares;

            document.querySelector('input[value="recover"]').disabled = this.selectedPlane.energy >= this.selectedPlane.maxEnergy;
            document.querySelector('input[value="maneuver"]').disabled = this.selectedPlane.energy < 1;
            document.querySelector('input[value="boost"]').disabled = this.selectedPlane.energy < 1;
            document.querySelector('input[value="turnaround"]').disabled = this.selectedPlane.energy < 2;

            document.querySelector('input[value="missile"]').disabled = this.selectedPlane.ammo.missiles <= 0;
            document.querySelector('input[value="flares"]').disabled = this.selectedPlane.ammo.flares <= 0;

            let activeFlight = document.querySelector('input[name="flight"]:checked');
            if (activeFlight && activeFlight.disabled) {
                document.querySelector('input[value="level"]').checked = true;
                this.selectedPlane.planned.flightAction = 'level';
                this.selectedPlane.planned.targetPos = null;
            } else {
                let radio = document.querySelector(`input[value="${this.selectedPlane.planned.flightAction}"]`);
                if (radio) radio.checked = true;
            }

            let activeWeapon = document.querySelector('input[name="weapon"]:checked');
            if (activeWeapon && activeWeapon.disabled) {
                document.querySelector('input[value="cannons"]').checked = true;
                this.selectedPlane.planned.weapon = 'cannons';
            } else {
                let weaponRadio = document.querySelector(`input[value="${this.selectedPlane.planned.weapon}"]`);
                if (weaponRadio) weaponRadio.checked = true;
            }

            let hint = document.getElementById('context-hint');
            if (this.selectedPlane.planned.flightAction === 'turnaround') {
                hint.innerText = "Click to the left or right of the plane to select turn direction.";
            } else if (this.selectedPlane.planned.weapon === 'missile' && !this.selectedPlane.planned.missileTarget) {
                hint.innerText = "Click an enemy within 90° forward arc to lock missile.";
            } else if (!this.selectedPlane.planned.targetPos) {
                hint.innerText = "Click within the yellow cone to set movement waypoint. You can drag it.";
            } else {
                hint.innerText = "Ready. Waypoint is draggable.";
            }
        } else {
            infoPanel.classList.add('hidden');
        }

        document.getElementById('btn-commit-turn').disabled = this.gameState !== 'planning';

        if (this.gameState === 'action_phase') {
            document.getElementById('turn-indicator').innerHTML = '<span class="player-turn" style="color:var(--accent-warning)">ACTION PHASE</span>';
            document.getElementById('turn-indicator').classList.add('action-phase');
            document.getElementById('btn-replay').classList.add('hidden');
        } else {
            document.getElementById('turn-indicator').innerHTML = '<span class="player-turn">PLANNING PHASE</span>';
            document.getElementById('turn-indicator').classList.remove('action-phase');
            if (this.recordedFrames.length > 0) document.getElementById('btn-replay').classList.remove('hidden');
        }
    }

    startActionPhase() {
        this.selectedPlane = null;
        this.isDraggingWaypoint = false;

        for (let p of this.planes) {
            if (p.team === 'player' && !p.isDestroyed && !p.planned.targetPos && p.planned.flightAction !== 'turnaround') {
                p.planned.targetPos = {
                    x: p.x + Math.cos(p.heading) * p.baseMoveDist,
                    y: p.y + Math.sin(p.heading) * p.baseMoveDist
                };
            }
        }

        this.ai.planTurn();

        this.gameState = 'action_phase';
        this.actionPhaseProgress = 0;
        this.recordedFrames = [];
        this.isReplaying = false;
        this.updateUI();

        for (let p of this.planes) {
            if (p.isDestroyed) continue;
            p.trail = []; // Clear trails at start of action

            p.maneuvering = false;
            p.cannonCooldown = 0;
            let a = p.planned.flightAction;
            if (a === 'recover') p.energy = Math.min(p.maxEnergy, p.energy + 1);
            if (a === 'maneuver') { p.energy -= 1; p.maneuvering = true; }
            if (a === 'boost') p.energy -= 1;
            if (a === 'turnaround') p.energy -= 2;

            p._startX = p.x;
            p._startY = p.y;
            p._startH = p.heading;

            if (a === 'turnaround') {
                p._endX = p.x;
                p._endY = p.y;
                p._endH = p.heading + Math.PI * p.planned.turnDirection;
            } else {
                p._endX = p.planned.targetPos.x;
                p._endY = p.planned.targetPos.y;
                p._endH = Math.atan2(p._endY - p._startY, p._endX - p._startX);

                p._P0 = { x: p.x, y: p.y };
                let dTarget = dist(p.x, p.y, p._endX, p._endY);
                p._P1 = {
                    x: p.x + Math.cos(p.heading) * (dTarget * 0.6),
                    y: p.y + Math.sin(p.heading) * (dTarget * 0.6)
                };
                p._P2 = { x: p._endX, y: p._endY };
            }

            if (p.planned.weapon === 'missile' && p.planned.missileTarget && !p.planned.missileTarget.isDestroyed) {
                this.missiles.push(new Missile(p.x, p.y, p.heading, p.planned.missileTarget, p.team));
                p.ammo.missiles -= 1;
                this.logMsg(`Fox-2! Missile away.`, p.team === 'player' ? 'log-player' : 'log-enemy');
            }

            if (p.planned.weapon === 'flares' && p.ammo.flares > 0) {
                // Sideways flares
                for (let side of [-1, 1]) {
                    let sideAngle = p.heading + (Math.PI / 2) * side;
                    let pushX = Math.cos(sideAngle) * 3 + (Math.random() - 0.5);
                    let pushY = Math.sin(sideAngle) * 3 + (Math.random() - 0.5);
                    this.flares.push(new Flare(p.x, p.y, pushX, pushY));
                }
                p.ammo.flares -= 1;
                this.logMsg(`Flares away!`, p.team === 'player' ? 'log-player' : 'log-enemy');
            }
        }
    }

    endActionPhase() {
        this.gameState = 'planning';

        for (let m of this.missiles) {
            m.life -= 1;
            if (m.life <= 0) m.isDestroyed = true;
        }
        this.missiles = this.missiles.filter(m => !m.isDestroyed && !m.hasHit);

        for (let f of this.flares) {
            f.life -= 1;
            if (f.life <= 0) f.isDestroyed = true;
        }
        this.flares = this.flares.filter(f => !f.isDestroyed);

        for (let p of this.planes) p.resetPlan();

        this.checkWinCondition();
        this.updateUI();
    }

    loop(timestamp) {
        let dt = timestamp - this.lastTime;
        this.lastTime = timestamp;

        if (this.isReplaying) {
            this.updateReplay();
        } else if (this.gameState === 'action_phase') {
            this.updateActionPhase();
        }

        this.updateAnimations();
        this.draw();

        requestAnimationFrame(this.loop.bind(this));
    }

    updateActionPhase() {
        this.actionPhaseProgress++;
        let t = this.actionPhaseProgress / this.actionDuration;

        for (let f of this.flares) {
            f.x += f.vx;
            f.y += f.vy;
            f.vx *= 0.94;
            f.vy *= 0.94;

            // Add smoke dots for flares
            if (this.actionPhaseProgress % 2 === 0) {
                this.smokeParticles.push({
                    x: f.x, y: f.y,
                    vx: (Math.random() - 0.5) * 0.5, vy: (Math.random() - 0.5) * 0.5,
                    life: 20, maxLife: 20, size: 4 + Math.random() * 4
                });
            }
        }

        for (let p of this.planes) {
            if (p.isDestroyed) continue;

            // Vapour trails
            if (this.actionPhaseProgress % 2 === 0) {
                p.trail.push({ x: p.x, y: p.y });
                if (p.trail.length > 40) p.trail.shift();
            }
            if (p.planned.flightAction === 'turnaround') {
                p.x = p._startX;
                p.y = p._startY;
                p.heading = p._startH + Math.PI * p.planned.turnDirection * t;
            } else {
                let nx = Math.pow(1 - t, 2) * p._P0.x + 2 * (1 - t) * t * p._P1.x + Math.pow(t, 2) * p._P2.x;
                let ny = Math.pow(1 - t, 2) * p._P0.y + 2 * (1 - t) * t * p._P1.y + Math.pow(t, 2) * p._P2.y;

                let dx = 2 * (1 - t) * (p._P1.x - p._P0.x) + 2 * t * (p._P2.x - p._P1.x);
                let dy = 2 * (1 - t) * (p._P1.y - p._P0.y) + 2 * t * (p._P2.y - p._P1.y);

                p.x = nx;
                p.y = ny;
                if (Math.hypot(dx, dy) > 0.1) {
                    p.heading = Math.atan2(dy, dx);
                }
            }

            for (let mt of this.mountains) {
                if (mt.containsPoint(p.x, p.y)) {
                    p.isDestroyed = true;
                    this.addAnimation({ type: 'explosion', x: p.x, y: p.y, life: 30, maxLife: 30 });
                    this.logMsg(`Terrain, terrain! ${p.type} lost.`, 'log-system');
                }
            }

            if (!p.isDestroyed) {
                for (let other of this.planes) {
                    if (other !== p && !other.isDestroyed) {
                        if (dist(p.x, p.y, other.x, other.y) < p.radius + other.radius) {
                            p.isDestroyed = true;
                            other.isDestroyed = true;
                            this.addAnimation({ type: 'explosion', x: p.x, y: p.y, life: 30, maxLife: 30 });
                            this.addAnimation({ type: 'explosion', x: other.x, y: other.y, life: 30, maxLife: 30 });
                            this.logMsg(`Mid-air collision between ${p.type} and ${other.type}!`, 'log-system');
                        }
                    }
                }
            }

            if (p.isDestroyed) continue;

            if (p.planned.weapon === 'cannons') {
                if (p.cannonCooldown > 0) p.cannonCooldown--;
                if (p.cannonCooldown <= 0) {
                    for (let e of this.planes) {
                        if (e.team !== p.team && !e.isDestroyed) {
                            let d = dist(p.x, p.y, e.x, e.y);
                            if (d <= p.cannonRange) {
                                let angleToPt = Math.atan2(e.y - p.y, e.x - p.x);
                                let aDiff = Math.abs(normalizeAngle(angleToPt - p.heading));
                                if (d * Math.sin(aDiff) <= e.radius * 1.5 && aDiff < Math.PI / 2) {
                                    let blocked = false;
                                    for (let mt of this.mountains) {
                                        let steps = Math.ceil(d / 10);
                                        for (let i = 0; i <= steps; i++) {
                                            if (mt.containsPoint(p.x + (e.x - p.x) * (i / steps), p.y + (e.y - p.y) * (i / steps))) {
                                                blocked = true;
                                                break;
                                            }
                                        }
                                        if (blocked) break;
                                    }
                                    if (blocked) continue;

                                    let dealt = e.takeDamage(p.cannonDamage);
                                    this.addAnimation({
                                        type: 'laser', x: p.x, y: p.y, tx: e.x, ty: e.y,
                                        life: 5, maxLife: 5, color: p.team === 'player' ? '#38bdf8' : '#ef4444'
                                    });
                                    if (dealt > 0) this.spawnCombatText(e.x, e.y, `-${dealt}`);
                                    else this.spawnCombatText(e.x, e.y, "DODGE");
                                    if (e.isDestroyed) this.logMsg(e.team === 'enemy' ? `Bandit splashed! ${e.type} down.` : `Mayday! Friendly ${e.type} shot down!`, 'log-system');
                                    p.cannonCooldown = 15;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }

        for (let m of this.missiles) {
            if (m.isDestroyed || m.hasHit) continue;

            let closestFlare = null;
            let minFlareD = 150;
            for (let f of this.flares) {
                if (!f.isDestroyed) {
                    let d = dist(m.x, m.y, f.x, f.y);
                    let angleToF = Math.atan2(f.y - m.y, f.x - m.x);
                    let aDiff = Math.abs(normalizeAngle(angleToF - m.heading));
                    if (d < minFlareD && aDiff < Math.PI / 2) {
                        minFlareD = d;
                        closestFlare = f;
                    }
                }
            }
            if (closestFlare) m.target = closestFlare;

            if (!m.target.isDestroyed) {
                let angleToTarget = Math.atan2(m.target.y - m.y, m.target.x - m.x);
                let aDiff = normalizeAngle(angleToTarget - m.heading);
                m.heading += aDiff * m.turnRate;
            }

            let moveStep = (m.speed / this.actionDuration);
            m.x += Math.cos(m.heading) * moveStep;
            m.y += Math.sin(m.heading) * moveStep;

            for (let pl of this.planes) {
                if (pl.isDestroyed || pl.team === m.team) continue;
                if (dist(m.x, m.y, pl.x, pl.y) < pl.radius * 2) {
                    m.hasHit = true;
                    let dealt = pl.takeDamage(m.damage);
                    this.addAnimation({ type: 'explosion', x: m.x, y: m.y, life: 20, maxLife: 20 });
                    if (dealt > 0) this.spawnCombatText(pl.x, pl.y, `-${dealt} (MISSILE)`);
                    else this.spawnCombatText(pl.x, pl.y, "DODGE");
                    if (pl.isDestroyed) this.logMsg(pl.team === 'enemy' ? `Bandit splashed by Fox-2!` : `Mayday! Friendly ${pl.type} hit!`, 'log-system');
                    break;
                }
            }

            if (!m.hasHit) {
                for (let f of this.flares) {
                    if (f.isDestroyed) continue;
                    if (dist(m.x, m.y, f.x, f.y) < f.radius * 2) {
                        m.hasHit = true;
                        f.isDestroyed = true;
                        this.addAnimation({ type: 'explosion', x: m.x, y: m.y, life: 20, maxLife: 20 });
                        this.spawnCombatText(f.x, f.y, "DECOY");
                        this.logMsg("Missile spoofed by countermeasures.", 'log-system');
                        break;
                    }
                }
            }
        }

        // Update smoke
        for (let i = this.smokeParticles.length - 1; i >= 0; i--) {
            let s = this.smokeParticles[i];
            s.x += s.vx; s.y += s.vy;
            s.life--;
            if (s.life <= 0) this.smokeParticles.splice(i, 1);
        }

        this.recordFrame();

        if (this.actionPhaseProgress >= this.actionDuration) this.endActionPhase();
    }

    recordFrame() {
        let frame = {
            planes: this.planes.map(p => ({ x: p.x, y: p.y, heading: p.heading, isDestroyed: p.isDestroyed, team: p.team, hp: p.hp, maxHp: p.maxHp, energy: p.energy, maxEnergy: p.maxEnergy, radius: p.radius, trail: [...p.trail] })),
            missiles: this.missiles.map(m => ({ x: m.x, y: m.y, heading: m.heading, isDestroyed: m.isDestroyed })),
            flares: this.flares.map(f => ({ x: f.x, y: f.y, isDestroyed: f.isDestroyed })),
            smoke: this.smokeParticles.map(s => ({ x: s.x, y: s.y, life: s.life, maxLife: s.maxLife, size: s.size })),
            animations: this.animations.map(a => ({ ...a }))
        };
        this.recordedFrames.push(frame);
    }

    startReplay() {
        this.isReplaying = true;
        this.replayFrame = 0;
        this.logMsg("Replaying mission events...", "log-system");
    }

    updateReplay() {
        this.replayFrame++;
        if (this.replayFrame >= this.recordedFrames.length) {
            this.isReplaying = false;
            this.logMsg("Replay complete.", "log-system");
        }
    }

    checkWinCondition() {
        let playersAlive = this.planes.filter(p => p.team === 'player' && !p.isDestroyed).length;
        let enemiesAlive = this.planes.filter(p => p.team === 'enemy' && !p.isDestroyed).length;

        if (playersAlive === 0 || enemiesAlive === 0) {
            this.gameState = 'game_over';
            const overlay = document.getElementById('game-over-overlay');
            overlay.classList.remove('hidden');

            if (playersAlive === 0) {
                document.getElementById('game-over-title').innerText = "MISSION FAILED";
                document.getElementById('game-over-title').style.color = "var(--accent-enemy)";
                document.getElementById('game-over-message').innerText = "All friendly forces destroyed.";
            } else {
                document.getElementById('game-over-title').innerText = "MISSION ACCOMPLISHED";
                document.getElementById('game-over-title').style.color = "var(--accent-player)";
                document.getElementById('game-over-message').innerText = "Air superiority achieved.";
            }
        }
    }

    logMsg(msg, className) {
        const log = document.getElementById('combat-log');
        const p = document.createElement('p');
        p.className = className;
        p.innerText = `> ${msg}`;
        log.appendChild(p);
        log.scrollTop = log.scrollHeight;
    }

    spawnCombatText(x, y, text) {
        const container = document.getElementById('combat-text-container');
        const el = document.createElement('div');
        el.className = 'combat-text';
        if (text === 'DODGE' || text === 'DECOY') el.classList.add('miss');
        el.innerText = text;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        container.appendChild(el);
        setTimeout(() => el.remove(), 1500);
    }

    addAnimation(anim) { this.animations.push(anim); }

    updateAnimations() {
        for (let i = this.animations.length - 1; i >= 0; i--) {
            let anim = this.animations[i];
            anim.life--;
            if (anim.life <= 0) this.animations.splice(i, 1);
        }
    }

    draw() {
        if (!this.ctx) return;
        this.ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);

        let drawData = {
            planes: this.planes,
            missiles: this.missiles,
            flares: this.flares,
            smoke: this.smokeParticles,
            animations: this.animations
        };

        if (this.isReplaying && this.recordedFrames[this.replayFrame]) {
            drawData = this.recordedFrames[this.replayFrame];
        }

        for (let mt of this.mountains) {
            this.ctx.save();
            this.ctx.translate(mt.x, mt.y);

            this.ctx.beginPath();
            this.ctx.moveTo(mt.points[0].x, mt.points[0].y);
            for (let i = 1; i < mt.points.length; i++) {
                this.ctx.lineTo(mt.points[i].x, mt.points[i].y);
            }
            this.ctx.closePath();

            this.ctx.fillStyle = '#1e293b';
            this.ctx.fill();
            this.ctx.lineWidth = 2;
            this.ctx.strokeStyle = '#334155';
            this.ctx.stroke();

            this.ctx.strokeStyle = '#475569';
            this.ctx.beginPath();
            for (let r of mt.ridges) {
                this.ctx.moveTo(r.x1, r.y1);
                this.ctx.lineTo(r.x2, r.y2);
            }
            this.ctx.stroke();

            this.ctx.restore();
        }

        // Draw Trails
        drawData.planes.forEach(p => {
            if (p.trail && p.trail.length > 1) {
                this.ctx.beginPath();
                this.ctx.moveTo(p.trail[0].x, p.trail[0].y);
                for (let i = 1; i < p.trail.length; i++) {
                    this.ctx.lineTo(p.trail[i].x, p.trail[i].y);
                }
                this.ctx.strokeStyle = p.team === 'player' ? 'rgba(56, 189, 248, 0.3)' : 'rgba(239, 68, 68, 0.3)';
                this.ctx.lineWidth = 4;
                this.ctx.setLineDash([]);
                this.ctx.stroke();
            }
        });

        if (this.gameState === 'planning' && !this.isReplaying) {
            for (let p of this.planes) {
                if (p.isDestroyed || p.team !== 'player') continue;

                if (p === this.selectedPlane) {
                    if (p.planned.flightAction === 'turnaround') {
                        let trnA = p.heading + Math.PI / 2 * p.planned.turnDirection;
                        let tx = p.x + Math.cos(trnA) * 40;
                        let ty = p.y + Math.sin(trnA) * 40;
                        this.ctx.beginPath();
                        this.ctx.moveTo(p.x, p.y);
                        this.ctx.lineTo(tx, ty);
                        this.ctx.strokeStyle = '#f59e0b';
                        this.ctx.lineWidth = 3;
                        this.ctx.stroke();
                        this.ctx.beginPath();
                        this.ctx.arc(tx, ty, 5, 0, Math.PI * 2);
                        this.ctx.fillStyle = '#f59e0b';
                        this.ctx.fill();
                    } else {
                        let params = p.getMoveParams();
                        this.ctx.beginPath();
                        let maxA = params.turnAngle;

                        this.ctx.arc(p.x, p.y, params.maxDist, p.heading - maxA, p.heading + maxA);
                        this.ctx.lineWidth = 4;
                        this.ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
                        this.ctx.stroke();

                        this.ctx.beginPath();
                        this.ctx.moveTo(p.x, p.y);
                        this.ctx.lineTo(p.x + Math.cos(p.heading - maxA) * params.maxDist, p.y + Math.sin(p.heading - maxA) * params.maxDist);
                        this.ctx.moveTo(p.x, p.y);
                        this.ctx.lineTo(p.x + Math.cos(p.heading + maxA) * params.maxDist, p.y + Math.sin(p.heading + maxA) * params.maxDist);
                        this.ctx.lineWidth = 1;
                        this.ctx.strokeStyle = 'rgba(245, 158, 11, 0.3)';
                        this.ctx.stroke();
                    }

                    if (p.planned.weapon === 'missile') {
                        this.ctx.beginPath();
                        this.ctx.moveTo(p.x, p.y);
                        this.ctx.arc(p.x, p.y, p.cannonRange * 1.5, p.heading - p.missileCone, p.heading + p.missileCone);
                        this.ctx.lineTo(p.x, p.y);
                        this.ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
                        this.ctx.fill();
                        this.ctx.strokeStyle = 'rgba(239, 68, 68, 0.4)';
                        this.ctx.setLineDash([5, 5]);
                        this.ctx.stroke();
                        this.ctx.setLineDash([]);
                    }
                }

                if (p.planned.targetPos && p.planned.flightAction !== 'turnaround') {
                    let _dist = dist(p.x, p.y, p.planned.targetPos.x, p.planned.targetPos.y);
                    let _cx = p.x + Math.cos(p.heading) * (_dist * 0.6);
                    let _cy = p.y + Math.sin(p.heading) * (_dist * 0.6);

                    this.ctx.beginPath();
                    this.ctx.moveTo(p.x, p.y);
                    this.ctx.quadraticCurveTo(_cx, _cy, p.planned.targetPos.x, p.planned.targetPos.y);
                    this.ctx.strokeStyle = '#38bdf8';
                    this.ctx.lineWidth = 2;
                    this.ctx.stroke();

                    this.ctx.beginPath();
                    this.ctx.arc(p.planned.targetPos.x, p.planned.targetPos.y, 4, 0, Math.PI * 2);
                    if (p === this.selectedPlane && this.isDraggingWaypoint) {
                        this.ctx.fillStyle = '#fef08a'; // highlight when dragging
                        this.ctx.arc(p.planned.targetPos.x, p.planned.targetPos.y, 8, 0, Math.PI * 2);
                    } else {
                        this.ctx.fillStyle = '#38bdf8';
                    }
                    this.ctx.fill();
                }

                if (p.planned.weapon === 'missile' && p.planned.missileTarget) {
                    this.ctx.beginPath();
                    this.ctx.moveTo(p.x, p.y);
                    this.ctx.lineTo(p.planned.missileTarget.x, p.planned.missileTarget.y);
                    this.ctx.strokeStyle = '#ef4444';
                    this.ctx.lineWidth = 2;
                    this.ctx.setLineDash([5, 5]);
                    this.ctx.stroke();
                    this.ctx.setLineDash([]);
                }
            }
        }

        // Draw Smoke
        drawData.smoke.forEach(s => {
            let alpha = s.life / s.maxLife;
            this.ctx.beginPath();
            this.ctx.arc(s.x, s.y, s.size * (1 + (1 - alpha)), 0, Math.PI * 2);
            this.ctx.fillStyle = `rgba(200, 200, 200, ${alpha * 0.4})`;
            this.ctx.fill();
        });

        // Flares
        for (let f of drawData.flares) {
            if (f.isDestroyed) continue;
            this.ctx.beginPath();
            this.ctx.arc(f.x, f.y, 3, 0, Math.PI * 2);
            this.ctx.fillStyle = '#fff';
            this.ctx.shadowColor = '#fff';
            this.ctx.shadowBlur = 10;
            this.ctx.fill();
            this.ctx.shadowBlur = 0;
        }

        // Missiles
        for (let m of drawData.missiles) {
            if (m.isDestroyed || m.hasHit) continue;
            this.ctx.save();
            this.ctx.translate(m.x, m.y);
            this.ctx.rotate(m.heading);
            this.ctx.fillStyle = '#fca5a5';
            this.ctx.fillRect(-6, -2, 12, 4);
            this.ctx.fillStyle = '#fbbf24';
            this.ctx.beginPath();
            this.ctx.arc(-8, 0, 3, 0, Math.PI * 2);
            this.ctx.fill();
            this.ctx.restore();
        }

        // Planes
        drawData.planes.forEach(plane => {
            if (plane.isDestroyed) return;

            this.ctx.save();
            this.ctx.translate(plane.x, plane.y);
            this.ctx.rotate(plane.heading);

            this.ctx.beginPath();
            this.ctx.moveTo(plane.radius, 0);
            this.ctx.lineTo(-plane.radius, plane.radius);
            this.ctx.lineTo(-plane.radius * 0.5, 0);
            this.ctx.lineTo(-plane.radius, -plane.radius);
            this.ctx.closePath();

            this.ctx.fillStyle = plane.team === 'player' ? '#38bdf8' : '#ef4444';

            if (plane === this.selectedPlane && this.gameState === 'planning' && !this.isReplaying) {
                this.ctx.shadowColor = this.ctx.fillStyle;
                this.ctx.shadowBlur = 15;
            }

            this.ctx.fill();
            this.ctx.lineWidth = 2;
            this.ctx.strokeStyle = '#fff';
            this.ctx.stroke();
            this.ctx.restore();

            let barW = 30;
            let barH = 4;
            let barX = plane.x - barW / 2;
            let barY = plane.y + plane.radius + 5;

            this.ctx.fillStyle = '#1e293b';
            this.ctx.fillRect(barX, barY, barW, barH);
            this.ctx.fillStyle = '#10b981';
            this.ctx.fillRect(barX, barY, barW * (plane.hp / plane.maxHp), barH);

            barY += 6;
            this.ctx.fillStyle = '#1e293b';
            this.ctx.fillRect(barX, barY, barW, barH);
            this.ctx.fillStyle = '#f59e0b';
            this.ctx.fillRect(barX, barY, barW * (plane.energy / plane.maxEnergy), barH);
        });

        // Animations
        drawData.animations.forEach(anim => {
            if (anim.type === 'laser') {
                let alpha = anim.life / anim.maxLife;
                this.ctx.strokeStyle = anim.color;
                this.ctx.globalAlpha = alpha;
                this.ctx.lineWidth = 2;
                this.ctx.beginPath();
                this.ctx.moveTo(anim.x, anim.y);
                this.ctx.lineTo(anim.tx, anim.ty);
                this.ctx.stroke();
                this.ctx.globalAlpha = 1.0;
            } else if (anim.type === 'explosion') {
                let alpha = anim.life / anim.maxLife;

                // Better explosion: inner glow and outer ring
                this.ctx.beginPath();
                this.ctx.arc(anim.x, anim.y, 25 * (1 - alpha), 0, Math.PI * 2);
                this.ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.8})`;
                this.ctx.fill();

                this.ctx.beginPath();
                this.ctx.arc(anim.x, anim.y, 40 * (1 - alpha), 0, Math.PI * 2);
                this.ctx.fillStyle = `rgba(245, 158, 11, ${alpha * 0.4})`;
                this.ctx.fill();

                // Sparks
                this.ctx.strokeStyle = `rgba(251, 191, 36, ${alpha})`;
                for (let i = 0; i < 8; i++) {
                    let angle = i * Math.PI / 4 + (1 - alpha);
                    let len = 15 * (1 - alpha);
                    this.ctx.beginPath();
                    this.ctx.moveTo(anim.x + Math.cos(angle) * 10, anim.y + Math.sin(angle) * 10);
                    this.ctx.lineTo(anim.x + Math.cos(angle) * (10 + len), anim.y + Math.sin(angle) * (10 + len));
                    this.ctx.stroke();
                }
            }
        });
    }
}

// Initialize Game
new Game();
