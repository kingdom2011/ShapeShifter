import { Path } from 'app/model/paths';
import {
  bisect,
  bisector,
  feature,
  mergeArcs,
  neighbors,
  polygonArea,
  polygonCentroid,
  polygonLength,
  shuffle,
  sum,
} from 'app/scripts/d3';
import { Geometry, Point, Polygon, Triangle } from 'app/scripts/d3/types';
import * as earcut from 'earcut';
import * as _ from 'lodash';

interface Topology {
  readonly type: string;
  readonly objects: {
    readonly triangles: {
      readonly type: string;
      readonly geometries: Array<Geometry>; // TODO: make this a readonly array
    };
  };
  readonly arcs: ReadonlyArray<[Point, Point]>;
}

export function triangulate(fromPath: Path, toPath: Path) {
  // TODO: make sure this works for paths with more than one subpath
  const points = fromPath.getCommands().map(cmd => [cmd.getEnd().x, cmd.getEnd().y] as Point);
  const cuts = earcut(_.flatten(points));

  const triangles: Triangle[] = [];
  for (let i = 0; i < cuts.length; i += 3) {
    // Save each triangle as segments [a, b], [b, c], [c, a].
    triangles.push([[cuts[i], cuts[i + 1]], [cuts[i + 1], cuts[i + 2]], [cuts[i + 2], cuts[i]]]);
  }

  const topology = createTopology(triangles, points);
  const pieces = collapse(topology, 8);
  console.info(pieces);

  // Turn MultiPolygon into list of rings
  const hawaiiPoints = toPath
    .getSubPaths()
    .map(s => s.getCommands().map(c => [c.getEnd().x, c.getEnd().y] as Point));
  console.info(toPath, hawaiiPoints);
  const destinations = hawaiiPoints; /*.map(function(poly) {
    console.info(poly[0]);
    return poly[0];
  });*/

  // Get array of tweenable pairs of rings
  const pairs = getTweenablePairs(pieces, destinations);
  console.info(pairs);

  // Collate the pairs into before/after path strings
  var pathStrings: any[] = [
    pairs
      .map(function(d) {
        return join(d[0]);
      })
      .join(' '),
    pairs
      .map(function(d) {
        return join(d[1]);
      })
      .join(' '),
  ];

  // For showing borderless when rejoined
  const pathStringPoints = join(points);
  console.info(pathStringPoints);
}

function createTopology(triangles: ReadonlyArray<Triangle>, points: ReadonlyArray<Point>) {
  var arcIndices = {},
    topology = {
      type: 'Topology',
      objects: {
        triangles: {
          type: 'GeometryCollection',
          geometries: [],
        },
      },
      arcs: [],
    };

  triangles.forEach(function(triangle) {
    var geometry = [];

    triangle.forEach(function(arc, i) {
      var slug = arc[0] < arc[1] ? arc.join(',') : arc[1] + ',' + arc[0],
        coordinates = arc.map(function(pointIndex) {
          return points[pointIndex];
        });

      if (slug in arcIndices) {
        geometry.push(~arcIndices[slug]);
      } else {
        geometry.push((arcIndices[slug] = topology.arcs.length));
        topology.arcs.push(coordinates);
      }
    });

    topology.objects.triangles.geometries.push({
      type: 'Polygon',
      area: Math.abs(
        polygonArea(
          triangle.map(function(d) {
            return points[d[0]];
          }),
        ),
      ),
      arcs: [geometry],
    });
  });

  // Sort smallest first
  topology.objects.triangles.geometries.sort(function(a, b) {
    return a.area - b.area;
  });

  return topology as Topology;
}

// Merge polygons into neighbors one at a time until only numPieces remain.
function collapse(topology: Topology, numPieces: number) {
  const geometries = topology.objects.triangles.geometries;
  const bisectorLeft = bisector(ascendingComparator((d: { area: number }) => d.area)).left;

  function mergeSmallestFeature() {
    const smallest = geometries[0];
    const neighborIndex = shuffle(neighbors(geometries)[0])[0];
    const neighbor = geometries[neighborIndex as number];
    // console.info(smallest, neighbors(geometries), neighborIndex);
    // TODO: remove cast to any
    const merged: any = mergeArcs(topology, [smallest, neighbor]);
    let features;

    // MultiPolygon -> Polygon
    merged.area = smallest.area + neighbor.area;
    merged.type = 'Polygon';
    merged.arcs = merged.arcs[0];

    // Delete smallest and its chosen neighbor
    geometries.splice(neighborIndex as number, 1);
    geometries.shift();

    // Add new merged shape in sorted order
    geometries.splice(bisectorLeft(geometries, merged.area), 0, merged);

    if (geometries.length > numPieces) {
      return mergeSmallestFeature();
    }
    // Merged down to numPieces
    // TODO: remove this cast to any
    features = (feature(topology, topology.objects.triangles) as any).features;
    return features.map(f => f.geometry.coordinates[0]);
  }

  if (geometries.length > numPieces) {
    // TODO: return something here (and in the else case)
    return mergeSmallestFeature();
  }
  // TODO: return something here (and in the else case)
  return undefined;
}

function ascendingComparator<D>(fn: (d: D) => number) {
  return (d: D, x: number) => {
    const a = fn(d);
    const b = x;
    return a < b ? -1 : a > b ? 1 : a >= b ? 0 : NaN;
  };
}

function getTweenablePairs(start, end) {
  console.info(start, end);

  // Rearrange order of polygons for least movement.
  start = closestCentroids(start, end);
  return start.map(function(a, i) {
    return align(a.slice(0), end[i].slice(0));
  });
}

function align(a, b) {
  // Matching rotation.
  if (polygonArea(a) * polygonArea(b) < 0) {
    a.reverse();
  }

  // Smooth out by bisecting long triangulation cuts
  bisectSegments(a, 25);
  bisectSegments(b, 25);

  // Same number of points on each ring
  if (a.length < b.length) {
    addPoints(a, b.length - a.length);
  } else if (b.length < a.length) {
    addPoints(b, a.length - b.length);
  }

  // Wind the first to minimize sum-of-squares distance to the second
  return [wind(a, b), b];
}

function addPoints(ring, numPoints) {
  var desiredLength = ring.length + numPoints,
    step = polygonLength(ring) / numPoints;

  var i = 0,
    cursor = 0,
    insertAt = step / 2;

  while (ring.length < desiredLength) {
    var a = ring[i],
      b = ring[(i + 1) % ring.length];

    var segment = distanceBetween(a, b);

    if (insertAt <= cursor + segment) {
      ring.splice(i + 1, 0, pointBetween(a, b, (insertAt - cursor) / segment));
      insertAt += step;
      continue;
    }

    cursor += segment;
    i++;
  }
}

function wind(ring, vs) {
  var len = ring.length,
    min = Infinity,
    bestOffset;

  for (var offset = 0, len = ring.length; offset < len; offset++) {
    var s = sum(
      vs.map(function(p, i) {
        var distance = distanceBetween(ring[(offset + i) % len], p);
        return distance * distance;
      }),
    );

    if (s < min) {
      min = s;
      bestOffset = offset;
    }
  }

  return ring.slice(bestOffset).concat(ring.slice(0, bestOffset));
}

function range(start, stop?, step?) {
  (start = +start), (stop = +stop), (step =
    (n = arguments.length) < 2 ? ((stop = start), (start = 0), 1) : n < 3 ? 1 : +step);

  var i = -1,
    n = Math.max(0, Math.ceil((stop - start) / step)) | 0,
    rng = new Array(n);

  while (++i < n) {
    rng[i] = start + i * step;
  }

  return rng;
}

// Find ordering of first set that minimizes squared distance between centroid pairs
// Could loosely optimize instead of trying every permutation (would probably have to with 10+ pieces)
function closestCentroids(start, end) {
  var min = Infinity,
    best,
    distances = start.map(function(p1) {
      return end.map(function(p2) {
        var distance = distanceBetween(polygonCentroid(p1), polygonCentroid(p2));
        return distance * distance;
      });
    });

  function permute(arr, order?, s?) {
    var cur,
      distance,
      order = order || [],
      s = s || 0;

    for (var i = 0; i < arr.length; i++) {
      cur = arr.splice(i, 1);
      distance = distances[cur[0]][order.length];
      if (arr.length) {
        permute(arr.slice(), order.concat(cur), s + distance);
        arr.splice(i, 0, cur[0]);
      } else if (s + distance < min) {
        min = s + distance;
        best = order.concat(cur);
      }
    }
  }

  permute(range(start.length));

  return best.map(function(i) {
    return start[i];
  });
}

function bisectSegments(ring, threshold) {
  for (var i = 0; i < ring.length - 1; i++) {
    while (distanceBetween(ring[i], ring[i + 1]) > threshold) {
      ring.splice(i + 1, 0, pointBetween(ring[i], ring[i + 1], 0.5));
    }
  }
}

function distanceBetween(a, b) {
  var dx = a[0] - b[0],
    dy = a[1] - b[1];

  return Math.sqrt(dx * dx + dy * dy);
}

function pointBetween(a, b, pct) {
  return [a[0] + (b[0] - a[0]) * pct, a[1] + (b[1] - a[1]) * pct];
}

function join(ring) {
  return 'M' + ring.join('L') + 'Z';
}

const texas = new Path(
  `M385.504 20.032l12.52.3 13.452.225 12.84.15 24.413.006 19.166-.244 17.324-.4.592 22.03.31 11.44.677 24.94.61 22.444
   1.59-.805 2.293 1.117 4.86 5.313 2.105 1.734 3.29.037.996-1.876 1.815.1 4.19 1.473.678-3.523 2.002 2.01 2.06.16-.264.967
   2.2 1.67-.104 1.303.987 3.937 2.415.423 2.265-.018 3.647-.68 2.322 1.747 1.973.166 2.303.957 2.68.023 1.57-1.408 2.34.53
   3.374 3.48 2.98-1.945-.056-1.007 1.128-1.28 2.284.825 2.37-.138 2.274.722 1.485-1.794 1.222 1.283-.903 2.19 1.43 2.843
   1.54.307 2.407-.663.913.557-.16 3.258-.912.754 3.893 1.776 2.435-1.28 1.334-2.534 1.08-.184 1.41-2.24.904-.216 2.33
   1.348.462 2.143 1.11.212 1.935-1.09 1.55.635.01 2.497 1.364.938 1.823-.134 1.09-1.835 2.943-.392.244-1.697 2.097-.055.855
   2.494-1.242 1.69.583 1.75 1.486 1.444 2.05-.382-.15-3.18 1.513-.675 2-3.395.198-1.82 1.655-1.133.705.445.517 2.116 1.175
   1.74 1.128-1.016 1.344.138 1.316 1.78 1.645-.437.742-.856.376-2.683 2.906.45-.884 2.38 1.843.786 1.4-.294 1.307 2.023
   2.463-.48 2.322 2.37.517 1.17 1.39-.443.706-3.225 2.547.76 1.373-.658.76-3.372 2.22-.626 1.297.307 3.506-1.324.63-1.15
   3.516 1.77.403-1.108 1.654.45.273-2.02 2.387-.1.724-.952 1.336-.092.884-1.563 1.645.59.864 1.747 3.242.267 2.783-.32
   3.807-2.472-.216-.883 1.062-1.256 2.2.85 4.136 2.613 1.795-.06 1.287.85 2.152 2.246 1.955 1.315 3.14.248 1.447 1.31
   1.87.112 1.702.667 1.598-.267 1.23 1.513 2.08-.023.6-.814 1.27.714 2.603 2.686 1.213-.754 1.56.18.48-1.34 3.158.222.517-1.27
   1.457 1.063 2.22-.75 1.503.8 3.083 22.477 1.39 10.263 2.548 18.533 2.012 14.555.93.313 2.144 2.72 2.613.768.16.795 3.497
   3.943-.386 1.07 1.833 1.846-.883 1.918.47.883-.592 1.84.93 1.66 1.504 1.197 1.55-.234.96.754-.855 1.753 2.275 1.053 1.373
   2.95-.404 2.45 3.026 1.822.01 1.15 1.494 2.737 1.345-1.11.807 3.024-.742 1.057 1.457.685.31 1.458-1.194 2.31 1.683
   2.668-.648 2.59.395 1.39-1.89 7.22-1.692 1.887.46 2-1.268.47-.65 2.157 2.163 4.21-1.917 2.405.122 2.673 2.726 2.75-.328
   2.31 1.523 3.036-.912 2.01.376 1.72-.537 1.37-1.673 1.975-2.407.28-.282 1.67-1.634 3.994-.15 2.682.394 1.274 2.482 2.006.8
   1.26-.49.856-1.607-.078-4.606.552-.847.216-2.576 1.38-2.98 2.258-4.314 2.337-11.478 7.153-1.27 1.205-1.682 2.627-.733.46-.92
   -.055.027-1.04 2.726-3.45.92-.653 1.928-.93.988-1.356.734-.492 1.936-.143 1.1-.593.037-1.436-.827.87-2.105-.87-1.56 1.183
   -3.357 1.044-2.218.935-.338-.833 1.353-3.188.273-1.775.14-2.067-.714-2.364-.752-1.027-.987-.13-1.85.7-.51-.395-.676.704.104.805
   -.676 1.518-.357 1.582-.405.823-1.607.667-.517-.446-.386-.974-1.137-.52-1.965-.47-.855-1.15-.705.03-.254 1.668 2.2.603.987.704
   -.79.778-.188.7.31.79 1.08.755-.11.538-.894 1.248-.16 1.21 1.683 1.062 3.018.414-.488.99-.517-.14-1.053.595.743.698.366
   1.297.988-.083 1.176.764 2.782.855-.46.393-1.476-.456-.677.3-.254 1.885-.35.893-.544.427-.668-.423-1.39 1.7-2.66 3.93-1.806
   1.536-.423-.79-1.524-.14.63 1.086-.235 1.03.687 2.76.113 1.362-.225.603-2.548 2.553-1.034.74-1.814 2.614-2.304 2.415-1.504.54
   -2.435 2.196-4.145 3.427-1.59.984-1.663.612-1.75.312-1.813.092-1.438.308-5.06 2.502.302.525-.01 2.243.46-.01 5.397-3.89
   1.437-.74 1.382-.286-4.278 3.57-2.416 1.545-3.93 1.37-2.2 2.15-2.17.993-2.378 1.82-.31-.592 1.22-1.104 5.34-3.474 1.213-.617
   -.252-1.404-.78-.33-.762.21-1.41 1.03-1.28.498-2.208 1.325-1.804.726-.752-.64.648-.428 1.777-.38.103-.917-1.56.54-.818-.042
   -.085-.823.762-1.564-.17-.593-2.53.51-.78.48-.92 1.384-1.41.843-.48-.792-1.494-1.42.385-1.214-.9-1.196-.697.68-.818-1.09
   -.33.318.94 1.738.734 1.836-.16 1.035 1.917.584-2.134 1.616-.686-.023.16-.893-.414-.81-1.372 1.17-.63-1.39-.864.276-1.193
   -.115-.414-.358-.48-1.858-1.006-.98-1.072.018-.47.34-.865-.56.376 1.885 1.645 2.07.32.746-.066 1.88 1.043-.095 2.54
   1.104.59.5.64 1.123-1.965 1.22.63.763 1.034-.842 1.147-.446 1.543.405 1.23.9.217 1.06-2.688 1.793-.743.267-5.932 4.025-.752
   -.492-.62.262-.743-1.04-.226-1.637-.564-.713-.94-.147-.282-1.072-.854-.514-1.166-1.33-.61.59 1.4 1.25.526 1.16-.282.487-2.21
   -1.08-.582.643.865 1.173 1.297 1.306.658 1.053-.583 2.432.902 1.62-.348.616-1.344 1.012-1.824 2.802-.583.492-1.898.814.32
   -1.68.79-1.53-.64-.797.498-1.613-.583-.608-1.297 2.263.564.432.02 1.4-.81 1.89-.432.238-1.457-.354.29-2.494-.553-.603
   -.555 1.012-1.316.994-1.495.776-1.166-.446-1.044.005-.423.91.837.576-1.495 1.8-.678 1.053.386.41 1.635.293 1.674 1.624.752
   -2.516 1.86-.966.8-1.458.6.82-.112 1.765.178.897-1.56 2.19-1.24 2.783-2.774 4.784-.827.744-1.335-1.803-1.307-.602-.93.198
   -1.56.832-1.514-.437-3.357.264-.272.588-1.09-.174-.254-.474-1.128.267.724 1.045.762.566.93.093 1.27-.405 1.343-.032.527.27
   -.235 1.308 1.042 2.028.677.56 3.684 1.243.272 1.288-.92 1.77-.114 1.524-1.165 2.788-.527 2.042-.16 1.385-.516.722-1.298
   4.825-.037 1.02-.424.364-2.53 1.28-.788 1.048-.564.22-.81-.478 1.41-.897.67-1.086.694-.27-.197-.75-.864-.405.122-1.752
   -.752.41-1.335 1.333.35.603-1.336 1.034-.667-.428-.658 1.145.13.595-1.174.285-.386-1.08-3.563-4.45-1.09-.938-1.325-.763.235
   1.075 1.466 1.288-.085.952 1.57 1.362.8 1.587.827.59-1.25 1.232-.978-.01-1.053-.368-.367.86 1.87.405 2.257-.473.696.285.582.97
   1.28-.018 1.587.258h1.56l3.14-2.07.6.35-.234 1.13-.47.226.197 2.136-.488.648.648 1.882-.733.984-1.24.386.732 1.4-.432.514.583
   1.11.066.762-.528.465-2.256.33-.46.742.263 1.954.29.79.912 1.137 1.673.622.583.552-.414.916-1.945-1.564-.453-.166-.376 1.34.03
   1.54.338.556 1.71.23.537.456.64 1.403.43 1.978 1.204 2.86.657 2.99 1.147 2.977-.395 1.182-1.42.764 1.438.373-.178 1.12.018 1.9
   1.288.134.63 1.642 1.457.175-.254 1.335 1.07-.543.527.525-.573.676-.085 1.96.375.418.93-.33.64.727-.47 1.1.996 1.816-.083
   2.37.29 1.223 1.505.93 1.664-.02 1.034.235-.33 1.15-1.023-.082-.395 1.96.29 1.38.857.617 1.352-1.08.62-.852.226-2.278.96-.27.46
   1.227.498 3.588-2.942.534-2.736.75-1.918 1.752-1.964.704.742 1.205-.46 1.845-2.98-.17-1.26-1.753-2.077.267-.535-1.555-2.21
   -.65-1.85-2.263-1.984-1.692-2.434.473-2.68-.308-.666-1.173-1.86.483-1.252-.524-3.58.86-.922-.575-2.05 1.23-2.79-.976-2.812.06
   -1.09.73-2.134-.638-3.3-2.13-.44-1.78-2.22.29-2.416-1.758-.92-1.19-1.655.882-3.31-1.94-3.422 1.084-.648-1.108-2.303-1.688-.79
   -1.394-1.128.267-1.9-1.996-3.064.962-.292-.805-2.246-.156-.81-1.076-1.484.487-1.137-.938-1.824.865-1.25-1.307.686-2.162-1.618
   -2.373-1.598-.42-.64-3.863-.977-1.578-.498-3.152-1.317-.915-.178-1.94-1.185-2.476-2.528-1.592-.423-1.936-2.126-.898.395-1.37
   -1.637-1.93-1.26-.215-.28-1.992.657-.56-.348-3.33.498-1.243-.742-3.243-2.275-.99-.433-3.018.546-3.372-.358-1.725.593-1.26-2.02
   -.828.592-3.027-1.316-1.84-2.538-1.54-1.4.74-1.26-1.468-2.125-.207-2.077-2.93-1.25-.396-.508-1.45-1.194.285-1.213-1.173-.43-2.45
   -.96-1.138.404-1.094-1.88-2.43.235-1.228-2.332-.47-1.26-3.292-1.38-.792-1.42-2.764-5.01-2-.537-1.855-1.362-.2-1.494-1.95.197
   -1.476-2.49-3.75.49-1.305-1.29-1.993 1.28-1.164-2.078-.575-.996-1.684.48-1.504-1.966-1.076-.6-1.385-1.524-.907-.348-3.524
   -1.222-1.78-.376-1.97-1.203-.44-1.062-2.987-1.138-.01-.733-4.34-1.11-4.477-2.462-1.675-2.49-4.86-3.056-1.395-.348-1.196-2.5
   -1.75-2.078-.74-1.278-1.83-.94-2.328-3.553-.79-.866-1.666-3.375-.97.77
   -1.257-1.43-1.14-1.305.256.44-2.47-.544-.81-1.898.29-.47-2.18-1.55-1.983-1.28-.18-.272-1.655-1.71.984-1.495.18.16-1.592-1.26
   -.046-3.046 1.95-.62-.73-1.89.358-2.717-1.187-6.636-.313-.997-.883-2.604 1.273-2.594-.354
   -1.645-.976-1.1-1.528-1.27.36-2.98-1.684-1.606.345-2.49 4.563-1.128-.543-3.046.405-1.363.947-.912
   -.59-2.856.99-1.203-.345-.695 2.83-1.608 1.508-.263 1.945-1.11.13-.422 2.258-1.175.883v1.292l-1.043 2.714.225 1.587-.81 1.725
   -1.26.096-1.22 4.104 1.475 1.738-3.3 1.955-1.08-.394-2.256 3.75-.782-.01-1.85 1.734.036 1.504-2.265 2.41-1.928-.76-1.833.245
   -.575-.7-2.82-1.196-1.87-.13-2.397-2.055-2.802-3.295-1.212-.864-2.99-.252-2.68-1.265-1.982-1.666-.968-2.07-5.462-1.532
   -1.795-.156-1.842-.8-2.332-1.63-.893-1.265-2.33-1.122-1.542-2.466.15-1.403-3.29-2.07-1.608.092-2.096-1.716-.122-.703-4.268-3.202
   -1.062-1.955-.066-2.636-4.38-8.013-.103-2.497-.743-3.51 1.1-5.644-.837-2.632-1.71-1.817.046-1.062-1.824-1.573.112-1.284-1.757
   -1.337-.263-4.62-.742-3.352-1.232-1.342
   -1.39-.543-.405-2.35-.752-1.082-2.05-.147-1.88-2.608-3.61-3.004-1.23.216-3.215-2.038-1.738-.694-.367-1.56-5.574-4.853-.817-3.008
   -2.18-2.742-2.153-1.044-1.128-1.324-1.203-.28-.63-1.528-2.492-3.988-2.22-1.22-.628-2.308-1.88
   -1.394-2.51-.42-2.003-1.365-3.017-2.723-.714-2.525-1.213-1.127-.76-3.032-2.295-4.67-2.453-1.627-1.495.537-1.25-1.605-1.683-1.34
   -1.918-2.607v-1.693l1.09-.538-.762-2.69.846-.797 18.932 1.6 11.515.985 19.704 1.513 17.945 1.14 17.06.967 20.82.952 24.01.824.61
   -21.538.61-21.427.856-18.565 1.1-24.114.433-15.746.77-26.215.507-17.54.3-10.226.584-20.374.367-14.283 1.307.032z`,
);

const hawaii = new Path(
  `M743.1 307.69l.77.577 1.527 1.154.393.31 1.36-.365 1.685-.454h.176l1.913.085 1.902.09.728.035 1.106.414 1.79.665 1.796.656.073.022
  1.742.557 1.818.583 1.82.593 1.82.584 1.82.59.292.102 1.45.727 1.714.857 1.725.855 1.706.86 1.712.852 1.717.847 1.714.848v.01l1.62.994
  1.626 1.006 1.625 1.005 1.63 1.003 1.63.996 1.624 1 1.165.72.458.287 1.626 1.002 1.633 1.015 1.64 1.015 1.63 1.01 1.63 1.013 1.637
  1.004.714.438.784.765 1.374 1.343 1.362 1.344 1.374 1.342 1.376 1.334.748.722.547.695 1.182 1.516 1.178 1.518.974 1.278.008.31.042
  1.933.068 1.91.046 1.34-.01.57-.02 1.91-.024 1.91-.025 1.916-.01.964.07.94.15 1.903.152 1.912.086.977.942-.052 1.91-.116.81-.056.978-.48
  1.723-.84 1.725-.842.675-.326.964.666 1.59 1.082 1.27.864.196.326 1.008 1.638.583.938-.052.814-.103 1.905-.1 1.905-.078 1.348.25.496.84
  1.717.7 1.448.18.262 1.077 1.59 1.06 1.575.015.016 1.42 1.278 1.427 1.266 1.424 1.275 1.425 1.283 1.027.93.48.207 1.763.733 1.764.736
  1.766.74 1.264.526.417.36 1.47 1.228.965.8.322.588.913 1.697.328.593-.102 1.218-.168
  1.902-.053.62-.77 1.053-.86 1.176-.296.372-1.2 1.512-1.207 1.52-1.2 1.503-1.2 1.49-.718.89-.724.284-1.79.708-1.79.7-1.523.597-.21.212
  -1.355 1.358-1.352 1.356-1.357 1.36-1.346 1.364-1.347 1.36-1.24 1.254-.137.042
  -1.824.565-1.828.566-1.818.568.004.024-.17 1.582-.3.09-1.85.498-1.855.5-.71.196-.938.742-1.514 1.188-1.51 1.185-.008.007-1.828.596
  -1.828.58-1.83.577-1.84.58-1.83.58-1.83.577-1.83.572-1.648.516-.174-.046-1.864-.43-1.868-.433-1.68-.388-.195-.01-1.92-.016-1.096
  -.004-.78.27-1.82.625-.278.092-1.364.893-1.603 1.05-.086.054-1.472 1.07-1.563 1.108-1.066.77-.382.47
  -1.19 1.505-.81 1.036-.592.108-1.88.337-.222.05-1.51.74-.52.258-1.1.778-1.567 1.11-1.563 1.113-.563.408-1.033.614-1.647.974
  -1.647.978-1.644.973-.663.396-1.063.385-.886.314-.677.677-1.358 1.356-1.36 1.352-1.358 1.36-.88.877-.26.633-.706 1.663v.118l.11 1.92.106
  1.914.065 1.127-.528.594-1.28 1.43-.59.652-.734.75-1.34 1.378-1.34 1.372-.666.69-.31.905-.637 1.81-.64 1.81-.49 1.348-.314.36-1.253
  1.457-.31.368-1.075.96-1.423 1.274-1.43 1.275-1.428 1.28-.075.08-1.17-.67.01-.438.023-1.9.005-.657-.997-.765-1.506-1.173-.345-.263
  -1.32-.662-1.7-.87-1.704-.86-.63-.324-1.036-.6-1.647-.973-1.65-.968-1.653-.968-.39-.22-1.22-.803-1.595-1.057-.53-.348-1.24-.312
  -1.85-.468-1.856-.465-1.854-.47-1.276-.325-.188
  -.558-.633-1.805-.64-1.8-.322-.902-.923-.262-.786-.225-.32-1.043-.56-1.835-.254-.836-.195-1.038-.354-1.883-.356-1.877-.208-1.087.14
  -.773.364-1.875.368-1.87.367-1.874.13-.63.166-1.247.24-1.9.245-1.907.242-1.898.25-1.906.242-1.902.242-1.91.243-1.907.24-1.897.24
  -1.9.25-1.905-.007-.026-.166-1.884-.158-1.65-.13-.224-.964-1.656-.77-1.323-.155-.37-.687-1.786-.692-1.794-.176-.43-.49-1.392-.646
  -1.804-.648-1.816-.64-1.813-.644-1.802-.252-.68-.762-.942-.588-.75-.428-.883-.827-1.736-.123-.246.136-1.645.11-1.406-.244-.44-.945
  -1.673-.412-.735-.27-1.046-.475-1.862-.083-.29-.585-1.51-.685-1.8-.23-.592-.746-1.065-1.094-1.593-.516-.746-.818-.625-1.228-.918
  -.254-.306-1.25-1.468-1.256-1.465-.146-.178-.606-1.59-.67-1.8-.683-1.803-.68-1.794-.674-1.803.002-.004.578-1.84.583-1.832.094
  -.323.626-1.465.764-1.77.045-.114 1.334-1.23 1.416-1.3.02-.03 1.536-1.095 1.16
  -.818.374-.41.93-1.06.19-.58.527-1.89.113-.28 1.32-1.107.613-.51 1.152-.456 1.84-.723 1.838-.722.87-.35.555-.94.98-1.71.98
  -1.71.277-.443.955-1.166.382-.472.63-1.14.916-1.682.908-1.68.432-.797.658-.76 1.255-1.448 1.003-1.164.372-.01 1.656-.07.065
  -.244.435-1.868.418-1.864.42-1.87.07-.338-.527-1.47-.43-1.187-.468-.44-1.396-1.302-.338-.32
  -.807-1.188-1.082-1.588-1.078-1.585-1.076-1.577-.673-.988-.226-.68-.6-1.82-.606-1.813-.59-1.734-.014-.062-.155-1.913-.16-1.91
  -.078-1-.013-.903-.022-1.902-.022-1.705.087-.18.82-1.712.83-1.72.628-1.307.32-.293 1.38-1.266.024.01 1.894-.03 1.907-.044.876
  -.02 1 .22 1.865.4 1.867.404 1.848.413 1.875.404.09.032 1.795.33 1.91.33.038.002 1.08 1.548.092.18.166 1.357.172.308 1.01 1.63.99
  1.59.027.023 1.79.68 1.795.674 1.48.535.322.17 1.677.916 1.354.745.236.28 1.246 1.453.85.99.548.246 1.752.757.877.375z
  m-122.858-53l-.234.39-.417.745-.416.746-.417.747-.106.14-.73.05-.853.052-.85.05-.853.052-.696.048-.204.01-.842-.094-.797
  -.137-.802-.137-.797-.124-.195-.04-.605.133-.79.16-.79.173-.782.168-.788.176-.787.17-.784.16-.786.17-.09.016-.71.073-.794.09
  -.806.095-.8.08-.802.094-.428.037-.29
  -.276-.57-.575-.57-.568-.574-.576-.565-.573-.32-.327.22-.296.48-.648.49-.643.365-.497.13-.13.597-.54.587-.54.592-.542.588-.54.248
  -.24.38-.27.66-.46.658-.45.658-.463.658-.447.607
  -.435.048-.053.695-.398.683-.405.683-.42.764-.41.765-.41.496-.256.36-.12.82-.294.82-.293.82-.294.82-.293.205
  -.063.724.044.868.056.867.056.564.03.274.213.607.58.608.583.534.597.537.597.534.6.47.53-.04.095-.31.745-.304.74
  -.304.735-.308.74-.312.738-.134.315.38.244.625.463.626.463.287.25zm-51.03-27.52l-1.204.085-2.268.142-2.282.136
  -.704.038-.93-1.28-1.34-1.845-.443-.616-.304-1.506-.37-1.76-.028-.488-.12-2.274-.1-2.276-.045-.826-.248-1.43-.256
  -1.547-.623-.36-1.65-.94-.357-.147-2.13-.82-2.13-.81-.882-.344-.76-1.185-.99-1.552.115-.54.69-2.21.05-.355 1.685-.967 1.3
  -.764.69-.162 2.37-.3 2.348-.28.242.006 2.204.304 2.35.324 2.348.323 2.35.324 2.348.322 1.822.254.498.374 1.812 1.514 1.812
  1.515 1.812 1.514.433.317 1.307 1.394 1.602 1.727 1.602 1.728.04.05 1.15 1.878.25.41.25 1.75-.078.032-.78 2.17-.137.217-1.16
  1.756-1.274 1.94-.548.774-1.313.595-2.128.975-2.127.977-.656.287-1.632.458-2.255.637-1.162.324z
  m42.677-42.202l.78.922.337.403 1.314.224.52.233
  2.19.988 1.148.526.41 1.077.26.664 1.543.438.017.085.305 2.38.125 1.006 1.057.924.81.706.758 1.098.45.644.67 1.47.32.703.878
  1.376.65 1.01 1.202-.1 1.118-.09.84-.986.628-.74 1.46-.016 1.08-.006 1.322-.146 2.4-.25 2.088-.206.325-.078 1.15-.277.994-.723
  1.938-1.428 1.265-.93.8-.29 1.272-.477 1.06-.064 2.407-.15.795-.042 1.607.227.562.077 1.76.56 1.022.332.728.82.242-.08 1.42
  -.492.787.475 1.354.822.33.758.372.846 1.024 1.08 1.666 1.856.617.695 1.282.92 1.133.807.778.728.983.927.182 1.06.024.152
  2.226.136.02-.03.437-.714 1.244.95.5.38.855 1.57.766 1.39.825.11 2.392.302 1.313.17.98.467 2.19 1.022 1.337.635.89.292
  2.31.728 2.293.725 1.033.335.608 1.18 1.09 2.16 1.08 2.15.238.462-.198 1.888-.26 2.402-.126 1.277-.534 1.015-1.124 2.13-.705
  1.35-.888.27-2.302.696-.04.013-1.314 1.984-1.32 2.023-.024.034-2.376.07-1.154.04-1.094.593-2.115 1.143-2.127 1.138-1.712.918
  -.466.004-2.412-.008-1.866-.013-.55-.042-2.09-.167-.313.04-2.1.18
  -.254.136-2.166 1.04-2.173 1.038-1.908.905-.288.14-2.136 1.112-2.145 1.117-1.863.973-.333-.058-2.4-.49-2.354-.517-1.585-.338
  -.755.238-.947.296-1.414.07-2.387.11-1.72.09-.49-.46-1.77-1.63-1.428-1.313-.125-.443-.287-.974-.952-1.02-.797-.84.927-.825.16
  -.142v-2.174l-.01-.312-.26-2.076-.293-2.4-.297-2.395-.285-2.295-.044-.105-.956-2.213-.128-.252-.025-2.234-.037-.688-.663-1.702
  -.28-.685-1.432-1.07-1.49-1.113-.647-.022-1.52.016-.875.342-1.063.43-.467 1.15-.3.683-1.64.255-.09-.04-2.03-1.305-1.83-1.152-.227
  -.045-2.366-.397-.245-.04-1.823-1.142-1.01-.628-1.193.138-.663.083-1.044-1.38-.68-.914-.87-.905-1.67-1.718-.614-.637-.93-1.187
  -1.484-1.895-1.275-1.633-.02-.33-.147-2.4-.017-.31-1.308-1.617-.013-.01.438-2.333.446-2.366.374-2.05.116-.32.795-2.288.25-.73.868
  -1.403.476-.767 1.493-.174.167-.013 1.1-1.215.04-.607.03-.47 1.184-.84.482.04 2.165.18.226-.094 2.1-.962.08.048 1.036.622z
  m-87.167-25.922l2.1.338 2.782-.176.32-.02 1.654.434 1.105 1.637
  1.997-.006 3.807.513 9.695 1.33 5.618.768 4.13.156.922.034 1.03-1.562.792-2.39 1.293-.31 1.774 2.294.074.288.58 2.336 2.976.877
  3.71.798.502-.006 6.092-.27 2.9-.418.767-.216 2.49-.85 3.555.07 3.263.876.37-.017 1.02-.15 1.353 1.685 2.133-.046 1.025.707-1.568
  3.063-.8 1.623-3.942 4.014-2.035 1.226-2.806 1.664-4.864 2.16-1.108.31-3.994.85-5.215-.47-.74-.15-4.56-.88-5.185-1.298-5.205-1.302
  -4.385-1.462-2.056-.68-7.786.684-1.308.086-6.25.378-2.473.354-2.342.332-3.822-.207-2.99.158-.922-.344-1.748-.676-1.426-2.104.014
  -2.65 1.086-2.247.325-.343 1.275-1.47 2.434-.982 2.184-2.542.526-2.175.135-.588-1.637-2.073 1.344-.973zm-85.145-51.66l.84 2.447
  1.417.778.746 2.42 2.318.228 2.258 3.1.035 3.188-1.71.85 1.027 6.132 2.842 1.035 2.262 3.36 2.004.676.285 1.032 1.338.48 2.098
  -2.78-1.972-1.31.2-1.59 1.43-.646 3.22.386 1.633-.452.376 1.018-1.906 1.93-.35 2.524.264 1.958 2.18 1.313 1.7 1.69.48 1.206
  -.575 1.598.47 1.587 1.423 2.168 2.844 1.847 2.724
  1.43.825.862-1.54 1.777-4.46 4.353-1.446.475-.396-2.125-1.158-.92-3.506.92-2.86.364-2.38 1.22-1.73 1.408-2.092.095-.95-.464-1.718
  -2.69-6.524-2.8-1.996-3.34-.94-.837-1.726 1.683 1.29 1.51-5.494.46.84-1.105-1.047-.83-2.1.104-.577-4.354 4.135-2.11.557-1.207-3.853
  -2.33-1.092 2.355-2.85-.736.84 2.142-.684.477-4.068-3.346.912 2.255 2.147 2.244 2.82 2.333-.658 2.124-2.34.99-7.903 1.624-2.433.247
  -2.132.627-2.746-1.594-1.192-4.678-1.383-3.747-2.987-4.024-2.445-1.216-.633-3.74-.824-1.976-3.742-2.914-1.562-2.44-.27-6.87-.86
  -1.262-5.64-4.656.867-.487 4.73-.935 5.566-.364 5.86.083 1.66-.472 2.052.432 1.054-2.518 2.37-1.398 3.793-3.073-.175-.835 2.158
  -4.18 4.704-4.23 4.16-1.205 2.667.624 1.634 1.956 2.16 1.72.092 1.482 1.15.537.104 1.183 1.147 1.185-.57 2.486 1.7 2.323 1.79
  1.707zM137.34 84.088l-.396.114-.785.227-.554.154-.202-.15-.665-.486-.662-.49-.203-.157-.543-.19-.775-.262-.168-.062-.206-.613-.28
  -.784-.262-.778-.26-.78-.278-.808-.26-.78-.146
  -.445.044-.386.082-.818.078-.815.087-.81.032-.392.17-.393.32-.748.327-.763.323-.757.286-.666.055-.065.565-.59.564-.583.558-.58.56
  -.59.55-.592.56-.577.552-.588.56-.582.5-.52.047-.08.643-.502.636-.502.634-.493.64-.496.64-.49.644-.497.137-.132.53-.314.7-.414.695
  -.41.69-.403.694-.41.69-.415.7-.414.513-.302.076-.21.292-.774.292-.76.296-.748.297-.76.122-.326-.033-.476-.043-.818-.036-.81-.028
  -.498.302-.136.833-.32.797-.323.655-.24.286.012.893.034.91.034.45.075.436.203.81.34.81.343.62.27.135.248.39.796.39.796.337.737.005.034
  -.505.6-.517.615-.524.622-.534.632-.52.618-.157.18-.19.546-.28.77-.252.767-.26.78-.05.114.162.66.195.78.194.786.186.776.177.727
  -.048.073-.476.657-.485.662-.477.665-.263.36-.34.168-.73.36
  -.73.373-.733.37-.727.37-.73.36-.265.14-.5.158-.775.244-.78.25-.42.138-.316.207-.69.433-.69.454-.68.44
  -.567.36-.122.102-.617.556-.61.538-.382.34-.136.287-.366.74-.364.725-.183.36-.14.384-.288.757-.283.762-.285.752-.287.747-.28.76-.287.76
  -.286.757-.283.755-.142.372zm106.417-63.164l1.94.92 2.077-.093 2.502 1.383.987 2.14 1.643 1.683.897.22 1.38 4.63 1.09.677-.264
  5.413-1.238 1.68-1.907 5.3-1.92 1.155-.198 3.9.524 5.112-.476 3.743-1.82.026-1.475.74 1.446 2.28-.778.962-1.543-.097-2.258
  1.907-.97 1.71-3.295 2.404-.217 1.063-1.444.227-1.32 1.49-5.86-1.998-3.604-.324-2.67.103-4.98-.982-1.912-.136-1.144-.996-.752
  1.11-1.128.253-.658-1.164-1.693-.76-1.507-1.23-2.07-3.66-1.505-.39-.563-1.14-1.316-.698-2.603-.417-3.61-1.662-4.708-1.25-1.51
  -3.712-1.13-.59-.945-1.426.277-5.283-.19-1.253 1.3-.487 3.5-4.01 1.835-2.383.398-3.577.877-.436 1.22-1.935 6.312-1.7 3.758-2.246
  2.352-2.096 3.016-1.497 1.127-1.42 1.696-.7h1.42l.94-1.02 1.374.28 1.42 1.756 2.78.645 1.148.74 1.164-2.128 2.382-.926 2.472.373
  2.977-.008 1.548.925 1.24-.188 2.598-1.854 1.534.923z`,
);

triangulate(texas, hawaii);
