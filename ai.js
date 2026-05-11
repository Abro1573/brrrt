class AIController {
    constructor(game) {
        this.game = game;
    }

    planTurn() {
        let enemies = this.game.planes.filter(p => p.team === 'enemy' && !p.isDestroyed);
        let players = this.game.planes.filter(p => p.team === 'player' && !p.isDestroyed);
        
        if (enemies.length === 0 || players.length === 0) return;

        for (let enemy of enemies) {
            enemy.resetPlan();
            let closest = this.getClosestTarget(enemy, players);
            
            // Check if closest is behind us
            let angleToClosest = 0;
            let isBehind = false;
            if (closest) {
                angleToClosest = Math.atan2(closest.y - enemy.y, closest.x - enemy.x);
                let diff = Math.abs(normalizeAngle(angleToClosest - enemy.heading));
                if (diff > Math.PI * 0.6) isBehind = true;
            }

            // Flight Action
            if (enemy.energy < 1) {
                enemy.planned.flightAction = 'recover';
            } else if (isBehind && enemy.energy >= 2) {
                enemy.planned.flightAction = 'turnaround';
                enemy.planned.turnDirection = Math.sign(normalizeAngle(angleToClosest - enemy.heading)) || 1;
            } else {
                let r = Math.random();
                if (r < 0.3) enemy.planned.flightAction = 'maneuver';
                else if (r < 0.6) enemy.planned.flightAction = 'boost';
                else enemy.planned.flightAction = 'level';
            }
            
            if (closest) {
                if (enemy.planned.flightAction === 'turnaround') {
                    enemy.planned.targetPos = { x: enemy.x, y: enemy.y };
                } else {
                    let params = enemy.getMoveParams();
                    
                    // Smarter maneuvering: find point that gets closest to target but avoids mountains
                    let bestPos = null;
                    let bestScore = -Infinity;
                    
                    // Sample angles at max distance within cone
                    let d = params.maxDist;
                    for (let a = -params.turnAngle; a <= params.turnAngle; a += params.turnAngle/4 + 0.01) {
                        let px = enemy.x + Math.cos(enemy.heading + a) * d;
                        let py = enemy.y + Math.sin(enemy.heading + a) * d;
                        
                        // Raycast-ish check for mountain collision
                        let hitsMountain = this.game.mountains.some(m => {
                            let dToLine = this.distToSegment(m, enemy, {x: px, y: py});
                            return dToLine < m.radius * 0.8 + 10;
                        });
                        
                        if (!hitsMountain) {
                            let score = -dist(px, py, closest.x, closest.y);
                            if (score > bestScore) {
                                bestScore = score;
                                bestPos = {x: px, y: py};
                            }
                        }
                    }
                    
                    if (bestPos) {
                        enemy.planned.targetPos = bestPos;
                    } else {
                        enemy.planned.targetPos = {
                            x: enemy.x + Math.cos(enemy.heading) * params.minDist,
                            y: enemy.y + Math.sin(enemy.heading) * params.minDist
                        };
                    }
                }

                // Weapons Logic
                let d = dist(enemy.x, enemy.y, closest.x, closest.y);
                let incoming = this.game.missiles.some(m => m.target === enemy && dist(m.x, m.y, enemy.x, enemy.y) < 350);
                
                if (incoming && enemy.ammo.flares > 0) {
                    enemy.planned.weapon = 'flares';
                } else if (d > enemy.cannonRange && enemy.ammo.missiles > 0 && enemy.isValidMissileTarget(closest)) {
                    enemy.planned.weapon = 'missile';
                    enemy.planned.missileTarget = closest;
                } else {
                    enemy.planned.weapon = 'cannons';
                }
            } else {
                enemy.planned.targetPos = {
                    x: enemy.x + Math.cos(enemy.heading) * enemy.baseMoveDist,
                    y: enemy.y + Math.sin(enemy.heading) * enemy.baseMoveDist
                };
            }
        }
    }

    getClosestTarget(plane, targets) {
        let minD = Infinity;
        let closest = null;
        targets.forEach(t => {
            if(t.isDestroyed) return;
            let d = dist(plane.x, plane.y, t.x, t.y);
            if (d < minD) {
                minD = d;
                closest = t;
            }
        });
        return closest;
    }

    distToSegment(p, v, w) {
        let l2 = dist(v.x, v.y, w.x, w.y);
        l2 = l2 * l2;
        if (l2 == 0) return dist(p.x, p.y, v.x, v.y);
        let t = ((p.x - v.x) * (w.x - v.x) + (p.y - v.y) * (w.y - v.y)) / l2;
        t = Math.max(0, Math.min(1, t));
        return dist(p.x, p.y, v.x + t * (w.x - v.x), v.y + t * (w.y - v.y));
    }
}
