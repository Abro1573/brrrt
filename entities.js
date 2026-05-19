// Helper functions
function normalizeAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

function dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
}

class Plane {
    constructor(x, y, team, type = "Fighter") {
        this.x = x;
        this.y = y;
        this.team = team;
        this.type = type;
        
        this.maxHp = 100;
        this.hp = this.maxHp;
        this.maxEnergy = 2;
        this.energy = this.maxEnergy;
        
        this.ammo = {
            missiles: 2,
            flares: 3
        };
        
        this.heading = team === 'player' ? -Math.PI/2 : Math.PI/2; 
        
        this.radius = 22; 
        this.baseMoveDist = 150; 
        this.turnCone = Math.PI / 3; 
        
        this.cannonRange = 300; 
        this.cannonCone = Math.PI / 36;
        this.cannonDamage = 15; 
        
        this.missileCone = Math.PI / 4; 
        
        this.isDestroyed = false;
        this.trail = [];
        this.resetPlan();
    }

    resetPlan() {
        this.planned = {
            flightAction: 'level', 
            weapon: 'cannons',     
            targetPos: null,       
            missileTarget: null,
            turnDirection: 1
        };
        this.maneuvering = false; 
    }

    takeDamage(amount) {
        if (this.maneuvering) {
            if (Math.random() < 0.6) return 0;
        }
        this.hp -= amount;
        if (this.hp <= 0) {
            this.hp = 0;
            this.isDestroyed = true;
        }
        return amount;
    }

    getMoveParams() {
        let maxDist = this.baseMoveDist;
        let turnAngle = this.turnCone;
        let flight = this.planned.flightAction;
        
        if (flight === 'boost') maxDist *= 1.4;
        if (flight === 'recover') maxDist *= 0.5;
        if (flight === 'maneuver') { maxDist *= 0.75; turnAngle *= 1.4; }
        if (flight === 'turnaround') turnAngle = 0; 
        
        return { minDist: 40, maxDist, turnAngle };
    }

    getAllowedAngleForDist(d, params) {
        let progress = (d - params.minDist) / (params.maxDist - params.minDist);
        progress = Math.max(0, Math.min(1, progress));
        return params.turnAngle * (0.1 + 0.9 * progress * progress);
    }

    isValidWaypoint(px, py) {
        if (this.planned.flightAction === 'turnaround') return false; 
        
        let d = dist(this.x, this.y, px, py);
        if (d < 10) return false;
        
        let params = this.getMoveParams();
        let angleToPt = Math.atan2(py - this.y, px - this.x);
        let diff = Math.abs(normalizeAngle(angleToPt - this.heading));
        
        return diff <= params.turnAngle + 0.2;
    }

    isValidMissileTarget(targetPlane) {
        if (targetPlane.isDestroyed || targetPlane.team === this.team) return false;
        let angleToPt = Math.atan2(targetPlane.y - this.y, targetPlane.x - this.x);
        let diff = Math.abs(normalizeAngle(angleToPt - this.heading));
        return diff <= this.missileCone;
    }
}

class Missile {
    constructor(x, y, heading, target, team) {
        this.x = x;
        this.y = y;
        this.heading = heading;
        this.target = target;
        this.team = team;
        
        this.speed = 300; 
        this.damage = 50;
        this.life = 3; 
        this.isDestroyed = false;
        this.hasHit = false;
        
        this.turnRate = 0.05;
    }
}

class Flare {
    constructor(x, y, vx, vy) {
        this.x = x;
        this.y = y;
        this.vx = vx;
        this.vy = vy;
        this.life = 2; 
        this.isDestroyed = false;
        this.radius = 10; 
    }
}

class Mountain {
    constructor(x, y, radius) {
        this.x = x;
        this.y = y;
        this.radius = radius;
        
        // Generate squarish irregular polygon for graphics
        this.points = [];
        this.ridges = [];
        
        let numPoints = 5 + Math.floor(Math.random() * 3);
        for(let i=0; i<numPoints; i++) {
            let angle = (i / numPoints) * Math.PI * 2;
            let aNoise = (Math.random() - 0.5) * 0.5;
            // 0.7 to 1.1 scale to make it blocky
            let rNoise = this.radius * (0.7 + Math.random() * 0.4); 
            this.points.push({
                x: Math.cos(angle + aNoise) * rNoise,
                y: Math.sin(angle + aNoise) * rNoise
            });
        }
        
        for(let i=0; i<4; i++) {
            this.ridges.push({
                x1: (Math.random() - 0.5) * this.radius * 1.2,
                y1: (Math.random() - 0.5) * this.radius * 1.2,
                x2: (Math.random() - 0.5) * this.radius * 1.2,
                y2: (Math.random() - 0.5) * this.radius * 1.2
            });
        }
    }

    containsPoint(px, py) {
        let x = px - this.x;
        let y = py - this.y;
        let inside = false;
        for (let i = 0, j = this.points.length - 1; i < this.points.length; j = i++) {
            let xi = this.points[i].x, yi = this.points[i].y;
            let xj = this.points[j].x, yj = this.points[j].y;
            
            let intersect = ((yi > y) != (yj > y))
                && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }
}
