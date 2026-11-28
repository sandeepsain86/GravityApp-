import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, EventEmitter, Input, OnChanges, OnDestroy, Output, ViewChild, effect, inject } from '@angular/core';
import {
  Chart,
  registerables,
  type ChartConfiguration,
  type ChartDataset,
  type ChartType,
} from 'chart.js';
import { ThemeService } from '../../core/services/theme.service';

Chart.register(...registerables);

export interface ChartSelection {
  label: string;
  datasetLabel: string;
  dataIndex: number;
  datasetIndex: number;
}

@Component({
  selector: 'app-admin-chart',
  template: '<div class="chart-frame" [class.chart-frame-compact]="compact"><canvas #canvas role="img" [attr.aria-label]="label"></canvas></div>',
  styles: [`
    :host { display: block; min-width: 0; }
    .chart-frame { position: relative; width: 100%; height: 220px; }
    .chart-frame-compact { height: 160px; }
    canvas { filter: none; }
    @media (max-width: 600px) {
      .chart-frame { height: 190px; }
      .chart-frame-compact { height: 140px; }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminChart implements AfterViewInit, OnChanges, OnDestroy {
  private readonly theme = inject(ThemeService);

  @Input({ required: true }) type: ChartType = 'bar';
  @Input() labels: string[] = [];
  @Input() datasets: ChartDataset<ChartType, number[]>[] = [];
  @Input() label = 'Data visualization';
  @Input() compact = false;
  @Input() horizontal = false;
  @Output() readonly chartSelect = new EventEmitter<ChartSelection>();

  @ViewChild('canvas') private canvas?: ElementRef<HTMLCanvasElement>;
  private chart?: Chart;

  constructor() {
    effect(() => {
      this.theme.mode();
      if (!this.chart) return;
      this.chart.options = this.createConfig().options ?? {};
      this.chart.update('none');
    });
  }

  ngAfterViewInit(): void {
    if (typeof CanvasRenderingContext2D === 'undefined' || !this.canvas) return;
    this.chart = new Chart(this.canvas.nativeElement, this.createConfig());
  }

  ngOnChanges(): void {
    if (!this.chart) return;
    const config = this.createConfig();
    this.chart.data = config.data;
    this.chart.options = config.options ?? {};
    this.chart.update();
  }

  ngOnDestroy(): void {
    this.chart?.destroy();
  }

  private createConfig(): ChartConfiguration<ChartType, number[], string> {
    const darkMode = typeof document !== 'undefined' &&
      document.documentElement.dataset['mode'] === 'dark';
    const textColor = typeof document !== 'undefined'
      ? getComputedStyle(document.documentElement).getPropertyValue('--t-2').trim()
      : '';
    const axisText = textColor || (darkMode ? '#c2c3dd' : '#586083');
    const gridColor = darkMode ? 'rgba(230, 231, 255, .1)' : 'rgba(56, 61, 100, .09)';
    const options: ChartConfiguration<ChartType, number[], string>['options'] = {
      responsive: true,
      maintainAspectRatio: false,
      onClick: (_event, activeElements) => {
        const element = activeElements[0];
        if (!element) return;
        this.chartSelect.emit({
          label: this.labels[element.index] ?? '',
          datasetLabel: this.datasets[element.datasetIndex]?.label ?? '',
          dataIndex: element.index,
          datasetIndex: element.datasetIndex,
        });
      },
      animation: {
        duration: this.prefersReducedMotion() ? 0 : 850,
        easing: 'easeOutQuart',
      },
      plugins: {
        legend: {
          position: 'bottom',
          labels: {
            color: axisText,
            usePointStyle: true,
            boxWidth: 7,
            padding: 16,
            font: { size: 10 },
          },
        },
      },
    };
    if (this.datasets.length < 2) {
      options.plugins = { ...options.plugins, legend: { display: false } };
    }

    if (this.type !== 'doughnut') {
      options.scales = {
        x: {
          grid: { display: false },
          ticks: { color: axisText, maxRotation: 0, font: { size: 9 } },
        },
        y: {
          beginAtZero: true,
          grid: { color: gridColor },
          ticks: { color: axisText, precision: 0, font: { size: 9 } },
        },
      };
    }
    if (this.type === 'bar' && this.horizontal) options.indexAxis = 'y';

    return {
      type: this.type,
      data: { labels: this.labels, datasets: this.datasets },
      options,
    };
  }

  private prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
}
