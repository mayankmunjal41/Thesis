
// Load data from json asynchronously and when it's loaded run the chart
d3.json('data.json').then(run)


function run(rawData) {

  //
  // Constants
  //

  
  const width = 1500 // Specify your desired width here
  const height = 330; // Specify your desired height here
  const margin = { top: 10, right: 130, bottom: 10, left: 10 };
  const curve = 0.7; // [0..1] // 0 - smooth, 1 - square
  const padding = 45; // minimum distance between nodes
  const psize = 8; // particle size
  const bandHeight = 40;
  const speed = 5;
  const density = 4;
  // const totalParticles = 500 // will be set below when the data is parsed


  //
  // State
  //
  const particles = []
  const cache = {}


  //
  // Data
  //

  const isLeaf = n => n.hasOwnProperty('vegan')


  // Extract unique nodes
  const nodes = (() => {
    const nodes = ['root']
    const walk = node => {
      for (let name in node) {
        nodes.push(name)
        if (!isLeaf(node[name])) {
          walk(node[name])
        }
      }
    }
    walk(rawData)
    return [...new Set(nodes)].map(name => ({ name }))
  })()


  // Extract all links between the nodes
  const links = (() => {
    const links = []
    const walk = (source, sourceNode) => {
      for (let name in sourceNode) {
        links.push({ source, target: name })
        if (!isLeaf(sourceNode[name])) {
          walk(name, sourceNode[name])
        }
      }
    }
    walk('root', rawData)
    return links
  })()


  // Common data structure format that d3 uses to layout networks (e.g. d3-sankey, d3-force)
  const dataForSankey = {
    nodes: nodes.map(n => ({ ...n, fixedValue: 1 })), // `fixedValue`, because all nodes have fixed height
    links: links.map(l => ({ ...l, value: 0 })), // `value: 0`, to start links from a single point
  }


  // Convert the raw data from nested object format into `d3-hierarchy` compatible format,
  // so we can use the power of `d3` to traverse nodes and paths to calculate distribution of particles
  const hierarchy = (() => {
    // converts an object { bitA, bitB, ... } into array [{ name: 'bitA', ... }, { name: 'bitB', ... }, ...]
    // `d3.hierarchy` will use this array to build its data structure
    const getChildren = ({ name, ...otherProps }) => isLeaf(otherProps) ? undefined // leaves have no children
      : Object.entries(otherProps).map(([name, obj]) => ({ name, ...obj }))
    const absolutePath = d => `${d.parent ? absolutePath(d.parent) : ''}/${d.data.name}`
    return d3.hierarchy({ name: 'root', ...rawData }, getChildren)
      // convert each nodes's data into universal format: `{ name, path, groups: [{ key, value }, ...] }`
      // so it does not depend on exact group names ('vegan', 'fevegan')
      // later it will allow to reuse the chart with other groups
      .each(d => {
        const datum = {
          name: d.data.name,
          // `path` is needed to distinguish nodes with the same name but different ancestors
          // (e.g. /root/bit501/bit601 vs /root/bit502/bit601)
          path: absolutePath(d),
        }
        if (isLeaf(d.data)) {
          datum.groups = [{
            key: 'vegan', value: d.data.vegan
          },{
            key: 'non-vegan', value: d.data['non-vegan']
          }]
        }
        d.data = datum
      })
  })()


  // Sankey layout is used to render the routes. It needs the intput data to be acyclic network
  const sankey = (() => {
    const sankey = d3.sankey()
      .nodeId(d => d.name)
      .nodeAlign(d3.sankeyJustify)
      // Adjust the following line to control the curvature. Lower values create a sharper curve. 
      .nodeWidth((width) / (hierarchy.height + 1) * (curve - 0.2)) // adjust curve here (e.g. 0.4 for a sharper curve)
      .nodePadding(padding)
      .size([width - margin.left - margin.right, height - margin.top - margin.bottom])
    return sankey(dataForSankey)
  })()


  // Consider different groups of the same route as different targets
  // Such data structure format simplifies particle creation and tracking
  const targetsAbsolute = hierarchy.leaves().flatMap(t => t.data.groups.map(g => ({
    name: t.data.name,
    path: t.data.path,
    group: g.key,
    value: g.value,
  })))


  const targets = (() => {
    // normalize values
    const total = d3.sum(targetsAbsolute, d => d.value)
    return targetsAbsolute.map(t => ({ ...t, value: t.value / total }))
  })()


  // Distribution of all possible types of particles (each route and each color)
  const thresholds = d3.range(targets.length).map(i => d3.sum(targets.slice(0, i + 1).map(r => r.value)))


  const routes = (() => {
    // Walk recursevly across all the nodes and build all possible
    // routes from the root node to each leaf node
    const walk = n => {
      const subroutes = n.sourceLinks.flatMap(d => walk(d.target))
      return subroutes.length ? subroutes.map(r => [n, ...r]) : [[n]]
    }
    const root = sankey.nodes.find(d => d.targetLinks.length === 0)
    return walk(root)
  })()


  // Unique nodes that have no children, used for rendering counters
  const leaves = sankey.nodes
    .filter(n => n.sourceLinks.length === 0)
    .map(n => ({
      node: n,
      targets: targetsAbsolute.filter(t => t.name === n.name)
    }))


  // set to absolute amount of students, but could be any value
  const totalParticles = d3.sum(targetsAbsolute, t => t.value)


  //
  // Scales
  //

  // takes a random number [0..1] and returns a target, based on distribution
  const targetScale = d3.scaleThreshold()
    .domain(thresholds)
    .range(targets)


  // takes a group type (e.g. 'vegan' or 'fevegan') and returns a color
  const colorScale = d3.scaleOrdinal()
    .domain(['non-vegan', 'vegan'])
    .range(['#e8754b', '#91A767'])


  // takes a random number [0..1] and returns vertical position on the band
  const offsetScale = d3.scaleLinear()
    .range([-bandHeight / 2 - psize / 2, bandHeight / 2 - psize / 2])


  // takes a random number [0..1] and returns particle speed
  const speedScale = d3.scaleLinear().range([speed, speed + 0.5])


  //
  // Code
  //

  // Randomly add from 0 to `density` particles per tick `t`
  const addParticlesMaybe = (t) => {
    const particlesToAdd = Math.round(Math.random() * density)
    for (let i = 0; i < particlesToAdd && particles.length < totalParticles; i++) {
      const target = targetScale(Math.random()) // target is an object: { name, path, group }
      const length = cache[target.path].points.length

      const particle = {
        // `id` is needed to distinguish the particles when some of them finish and disappear
        id: `${t}_${i}`,
        speed: speedScale(Math.random()),
        color: colorScale(target.group),
        // used to position a particle vertically on the band
        offset: offsetScale(Math.random()),
        // current position on the route (will be updated in `chart.update`)
        pos: 0,
        // when the particle is appeared
        createdAt: t,
        // total length of the route, used to determine that the particle has arrived
        length,
        // target where the particle is moving
        target,
      }
      particles.push(particle)
    }
  }

  const sankeyLinkCustom = nodes => {
    const p = d3.path();
    const h = bandHeight / 2;
    let offset = 0; // Adjust this offset to control starting positions for the links

    nodes.forEach((n, i) => {
        if (i === 0) {
            p.moveTo(n.x0 + offset, n.y0 + h); // Adjust offset here for starting positions
        }
        p.lineTo(n.x1, n.y0 + h);
        const nn = nodes[i + 1];
        if (nn) {
            const w = nn.x0 - n.x1;
            p.bezierCurveTo(
                n.x1 + w / 2, n.y0 + h,
                n.x1 + w / 2, nn.y0 + h,
                nn.x0, nn.y0 + h
            );
        }
    });
    return p.toString();
};



  




  //
  // Chart
  //

  function chart() {
    const svg = d3.select('#chart').append('svg')
      .attr('width', width)
      .attr('height', height)

    const g = svg.append('g').attr('transform', `translate(-60, ${margin.top})`)


    // Apart from aesthetics, routes serve as trajectories for the moving particles.
    // We'll compute particle positions in the next step
    //
    const route = g.append("g").attr('class', 'routes')
      .attr("fill", "none")
      .attr("stroke-opacity", 0)
      .attr("stroke", "#EEE")
      .selectAll("path").data(routes)
      .join("path")
        // use custom sankey function because we want nodes and links to be of equal height
        .attr('d', sankeyLinkCustom)
        .attr("stroke-width", bandHeight)


    // Compute particle positions along the routes.
    // This technic relies on path.getPointAtLength function that returns coordinates of a point on the path
    // Another example of this technic:
    // https://observablehq.com/@oluckyman/point-on-a-path-detection
    //
    route.each(function(nodes) {
      const path = this
      const length = path.getTotalLength()
      const points = d3.range(length).map(l => {
        const point = path.getPointAtLength(l)
        return { x: point.x, y: point.y }
      })
      // store points for each route in the cache to use during the animation
      const lastNode = nodes[nodes.length - 1]
      const key = '/' + nodes.map(n => n.name).join('/')
      cache[key] = { points }
    })


    // Create a container for particles first,
    // to keep particles below the labels which are declared next
    const particlesContainer = g.append('g')


    // Labels
    //
    g.selectAll('.label').data(sankey.nodes.slice(2)) // `.slice(1)` to skip the root node
      .join('g').attr('class', 'label')
      .attr('transform', d => `translate(${d.x1 - bandHeight / 2}, ${d.y0 + bandHeight / 2})`)
      .attr('dominant-baseline', 'middle')
      .attr('text-anchor', 'end')
      // This is how we make labels visible on multicolor background
      // we create two <text> with the same label
      .call(label => label.append('text')
        // the lower <text> serves as outline to make contrast
        .attr('stroke-width', 3)
        .text(d => d.name))
        .style('font-family', 'PT Sans')
        // the upper <text> is the actual label
      .call(label => label.append('text')
        .attr('fill', '#444')
        .text(d => d.name))


    // Counters
    //
    const counters = g.selectAll('.counter').data(leaves)
      .join('g').attr('class', 'counter')
      .attr('transform', d => `translate(${width - margin.left * 2 + 50}, ${d.node.y0})`)
      .each(function(leaf, i) {
        d3.select(this).selectAll('.group').data(['non-vegan','vegan'])
          .join('g').attr('class', 'group')
          .attr('transform', (d, i) => `translate(${-i * 80}, -15)`)
          // Align coutners to the right, because running numbers are easier for the eye to compare this way
          .attr('text-anchor', 'end')
          // Use monospaced font to keep digits aligned as they change during the animation
          .style('font-family', 'PT Sans')
          // Add group titles only once, on the top
          .call(g => i === 0 && g.append('text').attr('transform', 'translate(0, -10)')
            .attr('dominant-baseline', 'hanging')
            .attr('fill', '#FBEFDA')
            .style('font-size', 10)
            .style('text-transform', 'uppercase')
            .style('letter-spacing', .7) // a rule of thumb: increase letter spacing a bit, when use uppercase
            .text(d => d)
          )
          // Absolute counter values
          .call(g => g.append('text').attr('class', 'absolute')
            .attr('fill', d => colorScale(d))
            .attr('font-size', 16)
            .attr('dominant-baseline', 'middle')
            .attr('y', bandHeight / 2 - 2)
            .text(0) // will be updated during the animation
          )
          // Percentage counter values
          // .call(g => g.append('text').attr('class', 'percent')
          //   .attr('dominant-baseline', 'hanging')
          //   .attr('fill', '#999')
          //   .attr('font-size', 9)
          //   .attr('y', bandHeight / 2 + 9)
          //   .text('0%')  // will be updated during the animation
          // )
      })


      // update will be called on each tick, so here we'll perform our animation step
      function update(t) {
        // add particles if needed
        //
        addParticlesMaybe(t)

        // Function to calculate font size based on particle count
// Function to calculate font size based on particle count
function calculateFontSize(count) {
  // Adjust these values as per your preference
  const baseFontSize = 16;
  const scaleFactor = 5; // You can adjust this to control the scaling factor
  const maxFontSize = 30; // Maximum font size
  return Math.min(baseFontSize + scaleFactor * count, maxFontSize);
}

// Update counters
// Update counters
// Update counters
counters.each(function(d) {
  const finished = particles
    .filter(p => p.target.name === d.node.name)
    .filter(p => p.pos >= p.length);

  d3.select(this).selectAll('.group').each(function(group) {
    const count = finished.filter(p => p.target.group === group).length;
    let fontSize = 16; // Default font size

    // Calculate font size dynamically for vegan group

      const maxCount = 50; // Maximum count for scaling font size
      const scaleFactor = 5; // Scaling factor for font size
      const maxFontSize = 22; // Maximum font size

      // Calculate font size based on count
      fontSize = Math.min(16 + (count / maxCount) * scaleFactor, maxFontSize);


    const percentage = count / totalParticles * 100; // Calculate percentage for the progress bar

    // Update font size and text content
    d3.select(this).select('.absolute')
      .attr('font-size', fontSize) // Set font size dynamically
      .text(count);

    // Update percentage counter
    d3.select(this).select('.percent').text(d3.format('.0%')(count / totalParticles));

    // Update progress bar width
   
      const maxWidth = 300; // Set the maximum width for the progress bar
      const width = Math.min(percentage, maxWidth); // Set the width to the smaller of percentage and maxWidth
      d3.select(this).select('.progress-bar')
        .attr('width', width * 0.35 + '%'); // Set width of progress bar based on percentage
        
    
  });
});

// Append progress bar
counters.selectAll('.group')
  .filter(d => d === 'vegan')
  .append('rect')
  .attr('class', 'progress-bar')
  .attr('x', -35)
  .attr('y', bandHeight / 2 + 20) // Adjust the y position to place the progress bar under the counter
  .attr('height', 10) // Adjust height as needed
  .attr('fill', '#91A767') // Adjust color as needed
  .attr('width', 0); // Initial width is 0

  // Append progress bars for vegan ingredients
counters.selectAll('.group')
.filter(d => d === 'vegan')
.append('rect')
.attr('class', 'progress-bar vegan') // Add a class to identify vegan progress bars
.attr('x', -35)
.attr('y', bandHeight / 2 + 20) // Adjust the y position to place the progress bar under the counter
.attr('height', 10) // Adjust height as needed
.attr('fill', '#91A767') // Adjust color for vegan progress bars
.attr('width', 0); // Initial width is 0

// Append progress bars for non-vegan ingredients
counters.selectAll('.group')
.filter(d => d === 'non-vegan') // Filter for non-vegan groups
.append('rect')
.attr('class', 'progress-bar non-vegan') // Add a class to identify non-vegan progress bars
.attr('x', -35)
.attr('y', bandHeight / 2 + 20) // Adjust the y position to place the progress bar under the counter
.attr('height', 10) // Adjust height as needed
.attr('fill', '#e8754b') // Set color for non-vegan progress bars
.attr('width', 0); // Initial width is 0


        // move particles
        //
        particlesContainer.selectAll('.particle').data(particles.filter(p => p.pos < p.length), d => d.id)
          .join(
            enter => enter.append('circle')
              .attr('class', 'particle')
              .attr('opacity', 0.8)
              .attr('fill', d => d.color)
              .attr('width', psize)
              .attr('height', psize),
            update => update,
            exit => exit
              .remove() // uncomment to remove finished particles
          )
          // At this point we have `cache` with all possible coordinates.
          // We just need to figure out which exactly coordinates to use at time `t`
          //
          .each(function(d) {
            // every particle appears at its own time, so adjust the global time `t` to local time
            const localTime = t - d.createdAt
            d.pos = localTime * d.speed
            // extract the current and the next point coordinates from the precomputed cache
            const index = Math.floor(d.pos)
            const coo = cache[d.target.path].points[index]
            const nextCoo = cache[d.target.path].points[index + 1]
            if (coo && nextCoo) {
              // `index` is integer, but `d.pos` is float, so there are ticks when a particle is
              // between the two precomputed points. We use `delta` to compute position between the current
              // and the next coordinates to make the animation smoother
              const delta = d.pos - index // try to set it to 0 to see how jerky the animation is
              const x = coo.x + (nextCoo.x - coo.x) * delta
              const y = coo.y + (nextCoo.y - coo.y) * delta
              // squeeze particles when they close to finish
              const lastX = cache[d.target.path].points[d.length - 1].x
              const squeezeFactor = Math.max(0, psize - (lastX - x)) // gets from 0 to `psize`, when finish
              const r = Math.max(2, psize - squeezeFactor) / 2 // gets from `psize` to 2, then divide by 2 for radius
              d3.select(this)
                .attr('cx', x)
                .attr('cy', y + d.offset)
                .attr('r', r)
            }
          })
      } // update

      // expose the internal `update` function so it can be called from outside
      chart.update = update
  } // chart


  // Render the chart
  chart()

  // Run the animation ~60 times per second
  let elapsed = 0
  requestAnimationFrame(function update() {
    chart.update(elapsed++)
    requestAnimationFrame(update)
  })

  // Add an event listener for the restart button
document.getElementById('restartButton').addEventListener('click', restart);

// Function to restart the animation
function restart() {
  // Clear the existing particles
  particles.length = 0;

  // Reset the elapsed time
  elapsed = 0;

  // Clear the SVG
  d3.select('#chart svg').remove();

  // Rerun the chart setup
  chart();
}




} // run




// Read data
d3.csv("bubble-chart.csv").then( function (data) {
  console.log(data)
  // Filter data for Indian ingredients
  var indianData = data.filter(function (d) {
    return d.region === "Indian";
  });

  // Filter data for Southern US ingredients
  var southernUSData = data.filter(function (d) {
    return d.region === "Southern US";
  });

  // Filter data for Southern US ingredients
  var britishData = data.filter(function (d) {
    return d.region === "British";
  });

  var mexicanData = data.filter(function (d) {
    return d.region === "Mexican";
  });

  var chineseData = data.filter(function (d) {
    return d.region === "Chinese";
  });

  var moroccanData = data.filter(function (d) {
    return d.region === "Moroccan";
  });

  var koreanData = data.filter(function (d) {
    return d.region === "Korean";
  });

  var italianData = data.filter(function (d) {
    return d.region === "Italian";
  });

  // Create chart for Indian ingredients
  createBubbleChart("#indian_chart", indianData, "Indian");

  // Create chart for Southern US ingredients
  createBubbleChart(
    "#southern_us_chart",
    southernUSData,
    "Southern US"
  );

  createBubbleChart("#british_chart", britishData, "British");

  createBubbleChart("#mexican_chart", mexicanData, "Mexican");

  createBubbleChart("#italian_chart", italianData, "Italian");

  createBubbleChart("#chinese_chart", chineseData, "Chinese");

  createBubbleChart("#moroccan_chart", moroccanData, "Moroccan");

  createBubbleChart("#korean_chart", koreanData, "Korean");

});

// Function to create bubble chart
function createBubbleChart(container, data, title) {
  var width;
  if (window.innerWidth <= 768) {
    width = 250; // For screens less than or equal to 768px wide
  } else if (window.innerWidth <= 1024) {
    width = 180; // For screens less than or equal to 1024px wide
  } else {
    width = 250; // Default width for wider screens
  }
  var height;
  if (window.innerWidth <= 768) {
    height = 250; // For screens less than or equal to 768px wide
  } else if (window.innerWidth <= 1024) {
    height = 180; // For screens less than or equal to 1024px wide
  } else {
    height = 250; // Default width for wider screens
  }

	var height = 250;
  // Color palette for subregions
  var color = d3
    .scaleOrdinal()
    .domain([
      "Herbs & Spices",
      "Vegetables & Fruits",
      "Oils & Fats",
      "Dairy & Eggs",
      "Grains & Legumes",
      "Sauces & Condiments",
      "Other",
    ])
    .range([
      "#91A767",
      "#007832",
      "#EF9145",
      "#E05011",
      "#703A05",
      "#FCC10C",
      "#C0CDD3",
    ]);

  // Size scale for ingredient values
  var size = d3
    .scaleLinear()
    .domain([
      0,
      d3.max(data, function (d) {
        return +d.value;
      }),
    ])
    .range(getSizeRange()); // Circle will be between 7 and 55 pixels wide

// Function to get size range based on screen width
function getSizeRange() {
  if (window.innerWidth <= 768) {
    return [7, 20]; // For screens less than or equal to 768px wide
  } else if (window.innerWidth <= 1024) {
    return [7, 10]; // For screens greater than 768px and less than or equal to 1024px wide
  } else {
    return [7, 20]; // For screens wider than 1024px
  }
}
  // Create a tooltip
  var Tooltip = d3
    .select(container)
    .append("div")
    .style("opacity", 0)
    .attr("class", "tooltip")
    .style("background-color", "#fefceb")
    .style("border-width", "2px")
    .style("border-radius", "10px")
    .style("padding", "10px");

  // Function to show tooltip on mouseover
  var mouseover = function (d) {
    Tooltip.style("opacity", 1);
  };

  // Function to move tooltip with mouse
  var mousemove = function (d) {
    Tooltip.html("<strong>Frequency of " + d.key + "</strong>"+ ":" + "</br> " + d.value + '%')
      .style("left", d3.event.pageX + 20 + "px")
      .style("top", d3.event.pageY + "px")
      .style('text-align', 'left');
  };

  // Function to hide tooltip on mouseleave
  var mouseleave = function (d) {
    Tooltip.style("opacity", 0);
  };

  // Initialize the svg object
  var svg = d3
    .select(container)
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  // Initialize the circle nodes
  var node = svg
    .append("g")
    .selectAll("circle")
    .data(data)
    .enter()
    .append("circle")
    .attr("class", "node")
    .attr("r", function (d) {
      return size(d.value);
    })
    .attr("cx", width / 2)
    .attr("cy", height / 2)
    .style("fill", function (d) {
      return color(d.subregion);
    })
    .style("fill-opacity", 1)
    .on("mouseover", mouseover)
    .on("mousemove", mousemove)
    .on("mouseleave", mouseleave);

  // Apply forces to the nodes and update their positions
  var simulation = d3
    .forceSimulation()
    .force(
      "center",
      d3
        .forceCenter()
        .x(width / 2)
        .y(height / 2)
    )
    .force("charge", d3.forceManyBody().strength(0.1))
    .force(
      "collide",
      d3
        .forceCollide()
        .strength(0.8)
        .radius(function (d) {
          return size(d.value) + 1;
        })
        .iterations(1)
    )
    .nodes(data)
    .on("tick", function (d) {
      node
        .attr("cx", function (d) {
          return d.x;
        })
        .attr("cy", function (d) {
          return d.y;
        });
    });

  // Add a title to the chart
  svg
    .append("text")
    .attr("x", width / 2)
    .attr("y", height)
    .attr("text-anchor", "middle")
    .style("font-size", "16px")
    .style('font-family','PT Sans')
    .text(title);
}

window.addEventListener('DOMContentLoaded', (event) => {
  // Select all select elements
  const selectElements = document.querySelector('.fl-control')

  console.log(selectElements)
});

