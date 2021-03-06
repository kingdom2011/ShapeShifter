import { NumberProperty, Property } from 'app/model/properties';
import { MathUtil, Matrix, Point, Rect } from 'app/scripts/common';
import * as _ from 'lodash';

import { ConstructorArgs as AbstractConstructorArgs, AbstractLayer } from './AbstractLayer';

const DEFAULTS = {
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  pivotX: 0,
  pivotY: 0,
  translateX: 0,
  translateY: 0,
};

/**
 * Model object that mirrors the VectorDrawable's '<group>' element.
 */
@Property.register(
  new NumberProperty('rotation', { isAnimatable: true }),
  new NumberProperty('scaleX', { isAnimatable: true }),
  new NumberProperty('scaleY', { isAnimatable: true }),
  new NumberProperty('pivotX', { isAnimatable: true }),
  new NumberProperty('pivotY', { isAnimatable: true }),
  new NumberProperty('translateX', { isAnimatable: true }),
  new NumberProperty('translateY', { isAnimatable: true }),
)
export class GroupLayer extends AbstractLayer {
  constructor(obj: ConstructorArgs) {
    super(obj);
    const setterFn = (num: number, def: number) => (_.isNil(num) ? def : num);
    this.pivotX = setterFn(obj.pivotX, DEFAULTS.pivotX);
    this.pivotY = setterFn(obj.pivotY, DEFAULTS.pivotY);
    this.rotation = setterFn(obj.rotation, DEFAULTS.rotation);
    this.scaleX = setterFn(obj.scaleX, DEFAULTS.scaleX);
    this.scaleY = setterFn(obj.scaleY, DEFAULTS.scaleY);
    this.translateX = setterFn(obj.translateX, DEFAULTS.translateX);
    this.translateY = setterFn(obj.translateY, DEFAULTS.translateY);
  }

  getIconName() {
    return 'grouplayer';
  }

  getPrefix() {
    return 'group';
  }

  clone() {
    const clone = new GroupLayer(this);
    clone.children = this.children.slice();
    return clone;
  }

  deepClone() {
    const clone = this.clone();
    clone.children = this.children.map(c => c.deepClone());
    return clone;
  }

  getBoundingBox() {
    let bounds: Rect = undefined;
    this.children.forEach(child => {
      const childBounds = child.getBoundingBox();
      if (!childBounds) {
        return;
      }
      if (bounds) {
        bounds.l = Math.min(childBounds.l, bounds.l);
        bounds.t = Math.min(childBounds.t, bounds.t);
        bounds.r = Math.max(childBounds.r, bounds.r);
        bounds.b = Math.max(childBounds.b, bounds.b);
      } else {
        bounds = childBounds.clone();
      }
    });
    if (!bounds) {
      return undefined;
    }
    bounds.l -= this.pivotX;
    bounds.t -= this.pivotY;
    bounds.r -= this.pivotX;
    bounds.b -= this.pivotY;
    const transforms = [
      Matrix.fromScaling(this.scaleX, this.scaleY),
      Matrix.fromRotation(this.rotation),
      Matrix.fromTranslation(this.translateX, this.translateY),
    ];
    const topLeft = MathUtil.transformPoint(new Point(bounds.l, bounds.t), ...transforms);
    const bottomRight = MathUtil.transformPoint(new Point(bounds.r, bounds.b), ...transforms);
    return new Rect(
      topLeft.x + this.pivotX,
      topLeft.y + this.pivotY,
      bottomRight.x + this.pivotX,
      bottomRight.y + this.pivotY,
    );
  }

  toJSON() {
    const obj = Object.assign(super.toJSON(), {
      rotation: this.rotation,
      scaleX: this.scaleX,
      scaleY: this.scaleY,
      pivotX: this.pivotX,
      pivotY: this.pivotY,
      translateX: this.translateX,
      translateY: this.translateY,
      children: this.children.map(child => child.toJSON()),
    });
    Object.entries(DEFAULTS).forEach(([key, value]) => {
      if (obj[key] === value) {
        delete obj[key];
      }
    });
    return obj;
  }
}

interface GroupLayerArgs {
  pivotX?: number;
  pivotY?: number;
  rotation?: number;
  scaleX?: number;
  scaleY?: number;
  translateX?: number;
  translateY?: number;
}

export interface GroupLayer extends AbstractLayer, GroupLayerArgs {}
export interface ConstructorArgs extends AbstractConstructorArgs, GroupLayerArgs {}
