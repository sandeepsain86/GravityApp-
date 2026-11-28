import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../../../core/services/auth.service';

@Component({
  selector: 'app-login',
  imports: [ReactiveFormsModule, RouterLink],
  templateUrl: './login.html',
  styleUrl: './login.scss',
})
export class Login {
  private fb = new FormBuilder();
  private auth = inject(AuthService);
  private router = inject(Router);

  readonly showPassword = signal(false);
  readonly loading = signal(false);
  readonly serverError = signal<string | null>(this.auth.sessionError());

  readonly form = this.fb.nonNullable.group({
    email: ['', [Validators.required, Validators.email]],
    password: ['', [Validators.required]],
  });

  showError(control: 'email' | 'password'): boolean {
    const c = this.form.controls[control];
    return c.invalid && (c.dirty || c.touched);
  }

  async onSubmit(): Promise<void> {
    this.serverError.set(null);
    this.auth.clearSessionError();
    this.form.markAllAsTouched();
    if (this.form.invalid) return;

    this.loading.set(true);

    const { email, password } = this.form.getRawValue();
    const res = await this.auth.login(email, password);
    this.loading.set(false);

    if (res.ok) {
      await this.router.navigate([this.auth.firstAccessibleRoute()]);
    } else {
      this.serverError.set(res.message ?? 'Login failed.');
    }
  }

}
